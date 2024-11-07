import { SheetOCRBase } from '/ocr/SheetOCRBase.js';
import { bicubic, crop } from '/ocr/image_tools.js';

export class CPUOCR extends SheetOCRBase {
	// CPU-based OCR as a reference implementation
	// The method is the same as WebGL2 impl
	constructor(templates, palettes, config) {
		super(templates, palettes, config);
	}
	setConfig(config) {
		super.setConfig(config);
		this.updateCaptureContextFilters();
	}
	updateCaptureContextFilters() {
		if (!this.frame_canvas_ctx) return;
		if (!this.config) return;
		const filters = [];

		if (this.config.brightness && this.config.brightness > 1) {
			filters.push(`brightness(${this.config.brightness})`);
		}

		if (this.config.contrast && this.config.contrast !== 1) {
			filters.push(`contrast(${this.config.contrast})`);
		}

		if (filters.length) {
			this.frame_canvas_ctx.filter = filters.join(' ');
		} else {
			this.frame_canvas_ctx.filter = 'none';
		}
	}

	initCaptureContext(frame) {
		this.pending_capture_reinit = false;
		// Canvas for frame
		this.frame_canvas = document.createElement('canvas');
		this.frame_canvas.width = frame.width;
		this.frame_canvas.height =
			frame.height >> (this.config.use_half_height ? 1 : 0);
		this.frame_canvas_ctx = this.frame_canvas.getContext('2d', {
			alpha: false,
			willReadFrequently: true,
		});
		this.frame_canvas_ctx.imageSmoothingEnabled = false;

		// Canvas for sheet
		this.sheet_canvas = document.createElement('canvas');
		[this.sheet_canvas.width, this.sheet_canvas.height] =
			this.config.sheet_size;
		this.sheet_canvas_ctx = this.sheet_canvas.getContext('2d', {
			alpha: false,
			willReadFrequently: true,
		});
		this.sheet_canvas_ctx.imageSmoothingEnabled = true;

		this.updateCaptureContextFilters();
	}
	async processFrameStep1(frame) {
		if (!this.canvas_ctx || this.pending_capture_reinit) {
			this.initCaptureContext(frame);
		}
		this.frame_canvas_ctx.drawImage(
			frame,
			0,
			0,
			this.frame_canvas.width,
			this.frame_canvas.height
		);
		const frame_pixels = this.frame_canvas_ctx.getImageData(
			0,
			0,
			this.frame_canvas.width,
			this.frame_canvas.height
		);

		// Create sprite sheet
		this.sheet_canvas_ctx.fillStyle = 'rgb(128, 128, 128, 255)';
		this.sheet_canvas_ctx.fillRect(
			0,
			0,
			this.sheet_canvas.width,
			this.sheet_canvas.height
		);
		for (const [_, task] of Object.entries(this.config.tasks)) {
			// crop
			const crop_img = crop(frame_pixels, ...task.crop);
			// scale
			const scale_img = new ImageData(
				task.sheet_coordinates[2],
				task.sheet_coordinates[3]
			);
			bicubic(crop_img, scale_img);
			// draw
			this.sheet_canvas_ctx.putImageData(
				scale_img,
				task.sheet_coordinates[0],
				task.sheet_coordinates[1]
			);
		}
		const sheet_img = this.sheet_canvas_ctx.getImageData(
			0,
			0,
			this.sheet_canvas.width,
			this.sheet_canvas.height
		);

		// Get source img
		const source_img = crop(
			frame_pixels,
			this.config.capture_area.x,
			this.config.capture_area.y,
			this.config.capture_area.w,
			this.config.capture_area.h
		);
		this.config.source_img = source_img;

		return this.processFrameStep1_ocr(source_img, sheet_img);
	}
}

export class ComparingOCR {
	// Compare CPU/WebGL2 temporary images for verification. Not for practical use.
	constructor(templates, palettes, config) {}
	setConfig(config) {}
	async processFrameStep1(frame) {
		return null;
	}
	async processFrameStep2(partial_frame, level) {
		return null;
	}
}
