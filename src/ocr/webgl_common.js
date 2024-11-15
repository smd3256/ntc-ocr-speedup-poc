// Initialize a shader program
export function initShaderProgram(gl, vsSource, fsSource) {
	const vertexShader = loadShader(gl, gl.VERTEX_SHADER, vsSource);
	const fragmentShader = loadShader(gl, gl.FRAGMENT_SHADER, fsSource);

	const shaderProgram = gl.createProgram();
	gl.attachShader(shaderProgram, vertexShader);
	gl.attachShader(shaderProgram, fragmentShader);
	gl.linkProgram(shaderProgram);

	if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
		console.error(
			'Unable to initialize the shader program: ' +
				gl.getProgramInfoLog(shaderProgram)
		);
		return null;
	}

	return shaderProgram;
}

// Create a shader
function loadShader(gl, type, source) {
	const shader = gl.createShader(type);
	gl.shaderSource(shader, source);
	gl.compileShader(shader);

	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		console.error(
			'An error occurred compiling the shaders: ' + gl.getShaderInfoLog(shader)
		);
		gl.deleteShader(shader);
		return null;
	}

	return shader;
}

// Initialize buffers
export function initPointBuffersFor2D(gl) {
	const positionBuffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
	const positions = [-1.0, 1.0, 1.0, 1.0, -1.0, -1.0, 1.0, -1.0];
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);

	const textureCoordBuffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, textureCoordBuffer);
	const textureCoordinates = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0];
	gl.bufferData(
		gl.ARRAY_BUFFER,
		new Float32Array(textureCoordinates),
		gl.STATIC_DRAW
	);

	return {
		position: positionBuffer,
		textureCoord: textureCoordBuffer,
	};
}

// Vertex shader program
const vertexShaderSource = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() {
	gl_Position = vec4(a_position, 0.0, 1.0);
	v_texCoord = a_texCoord;
}`;

export function initWegGL2ResourcesFor2D(gl, fsSource, uniforms) {
	const program = initShaderProgram(gl, vertexShaderSource, fsSource);
	const programInfo = { program, a: {}, u: {} };
	const a_position = gl.getAttribLocation(program, 'a_position');
	const a_texCoord = gl.getAttribLocation(program, 'a_texCoord');
	for (const uname of uniforms) {
		programInfo.u[uname] = gl.getUniformLocation(program, uname);
	}
	const filterBuffers = initPointBuffersFor2D(gl);

	gl.bindBuffer(gl.ARRAY_BUFFER, filterBuffers.position);
	gl.vertexAttribPointer(a_position, 2, gl.FLOAT, false, 0, 0);
	gl.enableVertexAttribArray(a_position);

	gl.bindBuffer(gl.ARRAY_BUFFER, filterBuffers.textureCoord);
	gl.vertexAttribPointer(a_texCoord, 2, gl.FLOAT, false, 0, 0);
	gl.enableVertexAttribArray(a_texCoord);
	return programInfo;
}

// Initialize texture
export function initTextures(gl, units, clamp, sample) {
	clamp = clamp || gl.CLAMP_TO_EDGE;
	sample = sample || gl.LINEAR;
	const textures = [];
	for (let u of units) {
		const texture = gl.createTexture();
		gl.activeTexture(gl[`TEXTURE${u}`]);
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texImage2D(
			gl.TEXTURE_2D,
			0, // level
			gl.RGBA, // internal format
			1, // width
			1, // height
			0, // border
			gl.RGBA, // source format
			gl.UNSIGNED_BYTE, // source type
			new Uint8Array([0, 0, 255, 255]) // opaque blue
		);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, clamp);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, clamp);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, sample);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, sample);
		textures.push(texture);
	}

	return textures;
}

// Initialize texture array
export function initTextureArray(
	gl,
	unit,
	width,
	height,
	frames,
	clamp,
	sample
) {
	clamp = clamp || gl.CLAMP_TO_EDGE;
	sample = sample || gl.LINEAR;
	const texturearray = gl.createTexture();
	gl.activeTexture(gl[`TEXTURE${unit}`]);
	gl.bindTexture(gl.TEXTURE_2D_ARRAY, texturearray);

	gl.texImage3D(
		gl.TEXTURE_2D_ARRAY,
		0,
		gl.RGBA,
		width,
		height,
		frames,
		0,
		gl.RGBA,
		gl.UNSIGNED_BYTE,
		new Uint8Array(width * height * frames * 4)
	);

	gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

	return texturearray;
}

export function initRG32FTexture(gl, unit, width, height, data) {
	const texture = gl.createTexture();
	gl.activeTexture(gl[`TEXTURE${unit}`]);
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texImage2D(
		gl.TEXTURE_2D,
		0,
		gl.RG32F,
		width,
		height,
		0,
		gl.RG,
		gl.FLOAT,
		data
	);
	return texture;
}

export function initRGBA32FTexture(gl, unit, width, height, data) {
	const texture = gl.createTexture();
	gl.activeTexture(gl[`TEXTURE${unit}`]);
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texImage2D(
		gl.TEXTURE_2D,
		0,
		gl.RGBA32F,
		width,
		height,
		0,
		gl.RGBA,
		gl.FLOAT,
		data
	);
	return texture;
}
