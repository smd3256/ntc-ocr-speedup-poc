import { SheetOCRBase } from '/ocr/SheetOCRBase.js';
import { getVideoFrameSize } from '/ocr/utils.js';
import {
	initTextures,
	initRG32FTexture,
	initRGBA32FTexture,
	initWegGL2ResourcesFor2D,
} from '/ocr/webgl_common.js';

const FSforFilter = `#version 300 es
precision highp float;

uniform sampler2D u_frameTex;

uniform float u_amount, u_intercept;

in vec2 v_texCoord;
out vec4 outColor;

void main() {
	// Texture fetch
	vec3 c = texture(u_frameTex, vec2(v_texCoord.x , 1.0 - v_texCoord.y)).rgb;
	//vec3 c = texture(u_frameTex, v_texCoord).rgb;
	// Apply filter
	c = c * u_amount + u_intercept;
	// clamp
	c = clamp(c, 0.0, 1.0);
	outColor = vec4(c, 1.0);
}
`;

// Fragment shader for making a sheet
function getFSforSheet() {
	let stmt = '';
	function genKernel() {
		const coef_map = ['r', 'g', 'b', 'a'];
		const offset_map = [-1, 0, 1, 2];
		for (let y = 0; y < 4; y++) {
			stmt += `    vec3 y${y} = `;
			for (let x = 0; x < 4; x++) {
				if (x != 0) {
					stmt += ' + ';
				}
				stmt += `coefX.${
					coef_map[x]
				} * texture(u_sourceTex, coords + vec2(${offset_map[x].toFixed(
					1
				)}, ${offset_map[y].toFixed(1)}) * u_pitch).rgb`;
			}
			stmt += ';\n';
		}
		return stmt;
	}
	const source = `#version 300 es
precision highp float;

uniform sampler2D u_sourceTex;
uniform sampler2D u_coordsTex;
uniform sampler2D u_coefXTex;
uniform sampler2D u_coefYTex;

uniform vec2 u_pitch;

in vec2 v_texCoord;
out vec4 outColor;

void main() {
	vec3 c;
	vec2 tCoord = vec2(v_texCoord.x, 1.0 - v_texCoord.y);
	vec2 coords = texture(u_coordsTex, tCoord).rg;
	vec4 coefX = texture(u_coefXTex, tCoord);
	vec4 coefY = texture(u_coefYTex, tCoord);
${genKernel()}
	// Accumulate partial result
	c = coefY.r * y0 + coefY.g * y1 + coefY.b * y2 + coefY.a * y3;
	// clamp
	c = clamp(c, 0.0, 1.0);
	// fill gray if out of range
	c = (coords.r < 0.0 || coords.g < 0.0) ? vec3(0.5, 0.5, 0.5): c;
	outColor = vec4(c, 1.0);
}`;
	//console.log(`vertex shader: ${source}`);
	return source;
}

function TERP(t, a, b, c, d) {
	const ret =
		0.5 *
			(c -
				a +
				(2.0 * a - 5.0 * b + 4.0 * c - d + (3.0 * (b - c) + d - a) * t) * t) *
			t +
		b;
	return ret;
}

export class WebGL2OCR extends SheetOCRBase {
	// WebGL2-Accelerated OCR
	// 1. Crop, scale, and pack into a single image (something like sprite sheet) using GPU.
	// 2. Retrieve the image asynchronously (for overlapping other tasks).
	// 3. Run the OCR using scaled images. Impl is the same as the original.
	constructor(templates, palettes, config, sync) {
		super(templates, palettes, config);
		this.sync_readback = !!sync;
	}
	initWebGL2() {
		if (this.webgl2_initialized) return;
		this.webgl2_initialized = true;
		this.image_freelist = [];
		this.ppb_freelist = [];

		this.canvas = document.createElement('canvas');
		this.canvas.width = 1;
		this.canvas.height = 1;

		this.gl = this.canvas.getContext('webgl2', {
			desynchronized: true,
			preserveDrawingBuffer: true,
		});
		if (!this.gl) {
			console.error('WebGL2 not supported');
			return;
		}

		// for measurement
		this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');

		// create filte shader and related resources
		this.filterProgInfo = initWegGL2ResourcesFor2D(this.gl, FSforFilter, [
			'u_frameTex',
			'u_vscale',
			'u_voffset',
			'u_amount',
			'u_intercept',
		]);
		// create sheet shader and related resources
		this.sheetProgInfo = initWegGL2ResourcesFor2D(this.gl, getFSforSheet(), [
			'u_sourceTex',
			'u_coordsTex',
			'u_coefXTex',
			'u_coefYTex',
			'u_pitch',
		]);

		// create textures
		[this.frame_texture, this.source_texure] = initTextures(
			this.gl,
			[0, 1],
			null,
			this.gl.NEAREST
		);
		this.coord_texture = initRG32FTexture(this.gl, 15, 1, 1, null);
		this.coef_texture_x = initRGBA32FTexture(this.gl, 13, 1, 1, null);
		this.coef_texture_y = initRGBA32FTexture(this.gl, 14, 1, 1, null);

		// init framebuffer
		this.source_fbo = this.gl.createFramebuffer();
		this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.source_fbo);
		this.gl.framebufferTexture2D(
			this.gl.FRAMEBUFFER,
			this.gl.COLOR_ATTACHMENT0,
			this.gl.TEXTURE_2D,
			this.source_texure,
			0
		);
		this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
	}
	getImageData() {
		let img = this.image_freelist.pop();
		if (!img) {
			const source_img = new ImageData(
				this.config.capture_area.w,
				this.config.capture_area.h
			);
			const sheet_img = new ImageData(this.canvas.width, this.canvas.height);
			img = [source_img, sheet_img];
		}
		return img;
	}
	freeImageData(source_img, sheet_img) {
		if (
			source_img &&
			sheet_img &&
			source_img.width === this.config.capture_area.w &&
			source_img.height === this.config.capture_area.h &&
			sheet_img.width === this.canvas.width &&
			sheet_img.height === this.canvas.height
		) {
			this.image_freelist.push([source_img, sheet_img]);
		}
	}
	getPPB() {
		let ppb = this.ppb_freelist.pop();
		if (!ppb) {
			const source_ppb = this.gl.createBuffer();
			this.gl.bindBuffer(this.gl.PIXEL_PACK_BUFFER, source_ppb);
			this.gl.bufferData(
				this.gl.PIXEL_PACK_BUFFER,
				this.config.capture_area.w * this.config.capture_area.h * 4,
				this.gl.STREAM_READ
			);
			this.gl.bindBuffer(this.gl.PIXEL_PACK_BUFFER, null);
			const sheet_ppb = this.gl.createBuffer();
			this.gl.bindBuffer(this.gl.PIXEL_PACK_BUFFER, sheet_ppb);
			this.gl.bufferData(
				this.gl.PIXEL_PACK_BUFFER,
				this.canvas.width * this.canvas.height * 4,
				this.gl.STREAM_READ
			);
			ppb = {
				source_ppb,
				sheet_ppb,
				source_w: this.config.capture_area.w,
				source_h: this.config.capture_area.h,
				sheet_w: this.canvas.width,
				sheet_h: this.canvas.height,
			};
		}
		return ppb;
	}
	freePPB(ppb) {
		if (
			ppb.source_w === this.config.capture_area.w &&
			ppb.source_h === this.config.capture_area.h &&
			ppb.sheet_w === this.canvas.width &&
			ppb.sheet_h === this.canvas.height
		) {
			this.ppb_freelist.push(ppb);
		} else {
			this.gl.deleteBuffer(ppb.source_ppb);
			this.gl.deleteBuffer(ppb.sheet_ppb);
		}
	}
	setConfig(config) {
		super.setConfig(config);
		this.pending_capture_reinit = true;
		this.initWebGL2();
		if (config.ocr_show_sheet) {
			try {
				document.body.removeChild(this.canvas);
			} catch {}
			document.body.appendChild(this.canvas);
		}
		this.updateFilters();
	}
	reconfigureWebGL2(frame) {
		if (!this.gl) return;
		// FIXME: skip reinit when sizes are not changed
		this.image_freelist = [];
		this.ppb_freelist.forEach(({ source_ppb, sheet_ppb }) => {
			this.gl.deleteBuffer(source_ppb);
			this.gl.deleteBuffer(sheet_ppb);
		});
		this.ppb_freelist = [];

		this.pending_capture_reinit = false;
		[this.canvas.width, this.canvas.height] = this.config.sheet_size;
		this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);

		const [fw, fh] = getVideoFrameSize(frame);
		[this.frame_width, this.frame_height] = [
			fw,
			fh >> (this.config.use_half_height ? 1 : 0),
		];

		// init texture data
		const coords = new Float32Array(
			this.config.sheet_size[0] * this.config.sheet_size[1] * 2
		);
		const coords_b = new Float32Array(
			this.config.sheet_size[0] * this.config.sheet_size[1] * 2
		);
		const coefs_x = new Float32Array(
			this.config.sheet_size[0] * this.config.sheet_size[1] * 4
		);
		const coefs_y = new Float32Array(
			this.config.sheet_size[0] * this.config.sheet_size[1] * 4
		);
		for (let i = 0; i < coords.length; i++) {
			coords[i] = -1;
			coords_b[i] = -1;
		}
		for (let i = 0; i < coefs_x.length; i++) {
			coefs_x[i] = 0;
			coefs_y[i] = 0;
		}
		for (const [_, task] of Object.entries(this.all_tasks)) {
			const [x0, y0, width, height] = task.sheet_coordinates;
			const [sx0, sy0, swidth, sheight] = task.crop;
			const yscale = height / sheight;
			const xscale = width / swidth;
			for (let y = 0; y < height; y++) {
				const iyv = y / yscale;
				const iy0 = Math.floor(iyv);
				let repeatY = 0;
				if (iy0 < 1) repeatY = -1;
				else if (iy0 > sheight - 3) repeatY = iy0 - (sheight - 3);

				for (let x = 0; x < width; x++) {
					const ixv = x / xscale;
					const ix0 = Math.floor(ixv);
					coords[((y + y0) * this.config.sheet_size[0] + x + x0) * 2 + 0] =
						(sx0 + ix0 + 0.5) / this.frame_width;
					coords[((y + y0) * this.config.sheet_size[0] + x + x0) * 2 + 1] =
						(sy0 + iy0 + 0.5) / this.frame_height;

					let repeatX = 0;
					if (ix0 < 1) repeatX = -1;
					else if (ix0 > swidth - 3) repeatX = ix0 - (swidth - 3);
					const dx = ixv - ix0;
					const dy = iyv - iy0;
					const xc = [
						TERP(dx, 1, 0, 0, 0),
						TERP(dx, 0, 1, 0, 0),
						TERP(dx, 0, 0, 1, 0),
						TERP(dx, 0, 0, 0, 1),
					];
					if (repeatX < 0) {
						xc[1] += xc[0];
						xc[0] = 0;
					}
					if (repeatX > 0) {
						xc[2] += xc[3];
						xc[3] = 0;
					}
					if (repeatX > 1) {
						xc[1] += xc[2];
						xc[2] = 0;
					}
					const yc = [
						TERP(dy, 1, 0, 0, 0),
						TERP(dy, 0, 1, 0, 0),
						TERP(dy, 0, 0, 1, 0),
						TERP(dy, 0, 0, 0, 1),
					];
					if (repeatY < 0) {
						yc[1] += yc[0];
						yc[0] = 0;
					}
					if (repeatY > 0) {
						yc[2] += yc[3];
						yc[3] = 0;
					}
					if (repeatY > 1) {
						yc[1] += yc[2];
						yc[2] = 0;
					}
					coefs_x[((y + y0) * this.config.sheet_size[0] + x + x0) * 4 + 0] =
						xc[0];
					coefs_x[((y + y0) * this.config.sheet_size[0] + x + x0) * 4 + 1] =
						xc[1];
					coefs_x[((y + y0) * this.config.sheet_size[0] + x + x0) * 4 + 2] =
						xc[2];
					coefs_x[((y + y0) * this.config.sheet_size[0] + x + x0) * 4 + 3] =
						xc[3];
					coefs_y[((y + y0) * this.config.sheet_size[0] + x + x0) * 4 + 0] =
						yc[0];
					coefs_y[((y + y0) * this.config.sheet_size[0] + x + x0) * 4 + 1] =
						yc[1];
					coefs_y[((y + y0) * this.config.sheet_size[0] + x + x0) * 4 + 2] =
						yc[2];
					coefs_y[((y + y0) * this.config.sheet_size[0] + x + x0) * 4 + 3] =
						yc[3];
				}
			}
		}

		// init textures
		this.gl.activeTexture(this.gl.TEXTURE1);
		this.gl.texImage2D(
			this.gl.TEXTURE_2D,
			0, // level
			this.gl.RGBA, // internal format
			this.frame_width, // width
			this.frame_height, // height
			0, // border
			this.gl.RGBA, // source format
			this.gl.UNSIGNED_BYTE, // source type
			null
		);
		this.gl.activeTexture(this.gl.TEXTURE15);
		this.gl.texImage2D(
			this.gl.TEXTURE_2D,
			0, // level
			this.gl.RG32F, // internal format
			this.config.sheet_size[0], // width
			this.config.sheet_size[1], // height
			0, // border
			this.gl.RG, // source format
			this.gl.FLOAT, // source type
			coords
		);
		this.gl.activeTexture(this.gl.TEXTURE13);
		this.gl.texImage2D(
			this.gl.TEXTURE_2D,
			0, // level
			this.gl.RGBA32F, // internal format
			this.config.sheet_size[0], // width
			this.config.sheet_size[1], // height
			0, // border
			this.gl.RGBA, // source format
			this.gl.FLOAT, // source type
			coefs_x
		);
		this.gl.activeTexture(this.gl.TEXTURE14);
		this.gl.texImage2D(
			this.gl.TEXTURE_2D,
			0, // level
			this.gl.RGBA32F, // internal format
			this.config.sheet_size[0], // width
			this.config.sheet_size[1], // height
			0, // border
			this.gl.RGBA, // source format
			this.gl.FLOAT, // source type
			coefs_y
		);

		// init uniforms
		this.gl.useProgram(this.filterProgInfo.program);
		this.gl.uniform1i(this.filterProgInfo.u.u_frameTex, 0);
		this.gl.uniform1f(this.filterProgInfo.u.u_amount, 1);
		this.gl.uniform1f(this.filterProgInfo.u.u_intercept, 0);

		this.gl.useProgram(this.sheetProgInfo.program);
		this.gl.uniform1i(this.sheetProgInfo.u.u_sourceTex, 1);
		this.gl.uniform1i(this.sheetProgInfo.u.u_coordsTex, 15);
		this.gl.uniform1i(this.sheetProgInfo.u.u_coefXTex, 13);
		this.gl.uniform1i(this.sheetProgInfo.u.u_coefYTex, 14);
		this.gl.uniform2fv(this.sheetProgInfo.u.u_pitch, [
			1.0 / (this.frame_width || 1),
			1.0 / (this.frame_height || 1),
		]);
		this.updateFilters();
	}
	updateFilters() {
		if (!this.gl) return;
		if (!this.config) return;
		let brightness = 1;
		if (this.config.brightness && this.config.brightness > 1) {
			brightness = this.config.brightness;
		}
		let contrast = 1;
		if (this.config.contrast && this.config.contrast !== 1) {
			contrast = this.config.contrast;
		}
		const amount = contrast * brightness;
		const intercept = -(0.5 * contrast) + 0.5;
		if (this.gl) {
			this.gl.useProgram(this.filterProgInfo.program);
			this.gl.uniform1f(this.filterProgInfo.u.u_amount, amount);
			this.gl.uniform1f(this.filterProgInfo.u.u_intercept, intercept);
		}
	}
	getImageDataSync() {
		const [source_w, source_h, sheet_w, sheet_h] = [
			this.config.capture_area.w,
			this.config.capture_area.h,
			this.canvas.width,
			this.canvas.height,
		];
		const [source_img, sheet_img] = this.getImageData();
		this.gl.readPixels(
			0,
			0,
			sheet_w,
			sheet_h,
			this.gl.RGBA,
			this.gl.UNSIGNED_BYTE,
			sheet_img.data
		);
		if (show_parts) {
			this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.source_fbo);
			this.gl.readPixels(
				this.config.capture_area.x,
				this.config.capture_area.y,
				source_w,
				source_h,
				this.gl.RGBA,
				this.gl.UNSIGNED_BYTE,
				source_img.data
			);
		}
		this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
		return [source_img, sheet_img];
	}
	requestGetImageDataAsync() {
		if (!this.gl) return;
		// read sheet
		const ppb = this.getPPB();
		const [source_w, source_h, sheet_w, sheet_h] = [
			this.config.capture_area.w,
			this.config.capture_area.h,
			this.canvas.width,
			this.canvas.height,
		];
		this.gl.bindBuffer(this.gl.PIXEL_PACK_BUFFER, ppb.sheet_ppb);
		// Write data into PPB
		this.gl.readPixels(
			0,
			0,
			sheet_w,
			sheet_h,
			this.gl.RGBA,
			this.gl.UNSIGNED_BYTE,
			0
		);

		const show_parts = this.config.show_parts;
		if (show_parts) {
			// read source
			this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.source_fbo);
			// Create pixel pack buffer
			this.gl.bindBuffer(this.gl.PIXEL_PACK_BUFFER, ppb.source_ppb);
			// Write data into PPB
			this.gl.readPixels(
				this.config.capture_area.x,
				this.config.capture_area.y,
				source_w,
				source_h,
				this.gl.RGBA,
				this.gl.UNSIGNED_BYTE,
				0
			);
		}
		this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
		this.gl.bindBuffer(this.gl.PIXEL_PACK_BUFFER, null);
		// Create sync object
		const sync = this.gl.fenceSync(this.gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
		return { gl: this.gl, ppb, sync, show_parts };
	}
	finishGetImageDataAsync({ gl, ppb, sync, show_parts }) {
		return new Promise(resolve => {
			const checkSync = () => {
				if (
					gl.clientWaitSync(sync, gl.SYNC_FLUSH_COMMANDS_BIT, 0) ===
					gl.TIMEOUT_EXPIRED
				) {
					if (window.scheduler && window.scheduler.postTask) {
						// chrome only
						window.scheduler.postTask(checkSync);
					} else if (window.MessageChannel) {
						if (!this.mc) {
							this.mc = new window.MessageChannel();
						}
						this.mc.port2.addEventListener('message', checkSync, {
							once: true,
						});
						this.mc.port2.start();
						this.mc.port1.postMessage('message');
					} else {
						// last resort, need focus
						window.setTimeout(checkSync, 0);
					}
					return;
				}
				const [source_img, sheet_img] = this.getImageData();
				// Read buffer data
				gl.bindBuffer(gl.PIXEL_PACK_BUFFER, ppb.sheet_ppb);
				gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, sheet_img.data);
				if (show_parts) {
					gl.bindBuffer(gl.PIXEL_PACK_BUFFER, ppb.source_ppb);
					gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, source_img.data);
				}
				gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
				// clean up
				gl.deleteSync(sync);
				// reuse
				this.freePPB(ppb);
				resolve([source_img, sheet_img]);
			};
			checkSync();
		});
	}

	async processFrameStep1(frame) {
		// Buffer 1 frame in order to overlap cpu/gpu tasks
		if (!this.gl || this.pending_capture_reinit) {
			this.reconfigureWebGL2(frame);
		}
		let source_img, sheet_img;
		// Read rendering result of last frame
		if (this.sync_readback) {
			[source_img, sheet_img] = this.getImageDataSync();
			this.config.source_img = source_img;
		} else if (this.read_context) {
			[source_img, sheet_img] = await this.finishGetImageDataAsync(
				this.read_context
			);
			this.read_context = null;
			this.config.source_img = source_img;
		}
		// TODO: start measurement
		// Update texture
		this.gl.activeTexture(this.gl.TEXTURE0);
		this.gl.texImage2D(
			this.gl.TEXTURE_2D,
			0, // level
			this.gl.RGBA, //internalFormat
			this.gl.RGBA, //srcFormat
			this.gl.UNSIGNED_BYTE, //srcType
			frame
		);
		// filter
		this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.source_fbo);
		this.gl.useProgram(this.filterProgInfo.program);
		this.gl.viewport(0, 0, this.frame_width, this.frame_height);
		this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
		// Create sheet
		this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
		this.gl.useProgram(this.sheetProgInfo.program);
		this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
		this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
		if (!this.sync_readback) {
			this.read_context = this.requestGetImageDataAsync();
		}
		// TODO: finish measurement
		this.gl.flush();
		if (source_img && sheet_img) {
			performance.mark('cpu_step1_start');
			const result = this.processFrameStep1_ocr(source_img, sheet_img);
			performance.measure('cpu_step1', 'cpu_step1_start');
			return result;
		}
		return null;
	}
	async processFrameStep2(partial_frame, level) {
		performance.mark('cpu_step2_start');
		const result = super.processFrameStep2(partial_frame, level);
		performance.measure('cpu_step2', 'cpu_step2_start');
		const [source_img, sheet_img] = [
			partial_frame.source_img,
			partial_frame.sheet_img,
		];
		this.freeImageData(source_img, sheet_img);
		return result;
	}
}
