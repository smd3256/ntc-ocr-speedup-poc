import ScoreFixer from '/ocr/ScoreFixer.js';
import { PIECES, TRANSITIONS } from '/views/constants.js';
import TetrisOCR from '/ocr/TetrisOCR.js';

const BUFFER_MAXSIZE = 3; // all tracked changes are stable over 2 frames - using 3 for safety

function peek(arr, offset = 0) {
	return arr[arr.length - (offset + 1)];
}

/*
 * GameTracker is in charge of OCRing from game frames and sanitizing game data
 * It produces onMessage events with a TWO FRAMES delay for tracking
 *
 * That is because with intelaced input, a change occurs over 2 frame.
 * Reading a value as soon as it is changed can yield incorrect values, since the OCR was performed on
 * a transition interlaced frame. One frame delay may help to correct but to be more conservative, we use 2 frames.
 *
 * The buffering is done with an understanding of how Tetris fields are connected
 * Score: may change independently (push down points)
 * Lines: can only increase if score increase
 * Level: can only increase if lines increase
 * Piece counters: Can change independently (but only one at a time!)
 * Instant Das: changes at every frame: cannot be buffered to stability (read and hope for the best)
 * Cur piece Das: Changes on piece change
 * Preview: Can change independently
 * Cur piece:  Can change independently
 *
 * The Sanitizer Also corrects invalid detection on the high scores and level, where scores greater than 1M are rendered with letter.
 */

export default class GameTracker {
	constructor(templates, palettes, config) {
		this.config = config;
		this.tetris_ocr = new TetrisOCR(templates, palettes, config);

		this.frame_buffer = [];
		this.score_fixer = new ScoreFixer();

		this.gameid = this.getNextGameId();
		this.in_game = false;
		this.start_level = 0;

		this.score_frame_delay = 0;
		this.lines_frame_delay = 0;
		this.piece_frame_delay = 0;

		this.palette = Array(10).fill();
	}

	setConfig(config) {
		this.config = config;
		this.tetris_ocr.setConfig(config);
	}

	// class user to implement
	onNewGame() {}
	onMessage() {}
	onPalette() {}

	_getLevelFromLines(lines, ocr_level_digits) {
		if (lines === null || ocr_level_digits === null) return null;
		if (!this.transition) return GameTracker.digitsToValue(ocr_level_digits);
		if (lines < this.transition) return this.start_level;
		return this.start_level + 1 + Math.floor((lines - this.transition) / 10);
	}

	getNextGameId() {
		let new_game_id = 0;

		// we want to minimize the risk of gameid being duplicated when the producer page refreshes
		if (this.gameid === undefined) {
			new_game_id = localStorage.getItem('gameid');

			if (new_game_id !== null) {
				new_game_id = parseInt(new_game_id) + 1; // could be NaN if local storage value is garbage (shouldn't happen, just being paranoid)
			}

			if (new_game_id === null || isNaN(new_game_id)) {
				new_game_id = Date.now() + Math.floor(Math.random() * (1 << 30));
			}
		} else {
			new_game_id = this.gameid + 1;
		}

		new_game_id %= 0xffff; // because gameid in binary frame format is 16 bits

		if (!new_game_id) new_game_id = 1; // never report gameid as 0, so we can always assume a valid gameid is truthy

		localStorage.setItem('gameid', new_game_id);

		return new_game_id;
	}

	async processFrame(bitmap) {
		// ======= OCR step 1 (Sanitize)
		const last_frame = await this.tetris_ocr.processFrameStep1(bitmap);
		if (!last_frame) {
			return null;
		}

		if (this.frame_buffer.length < BUFFER_MAXSIZE) {
			this.frame_buffer.push(last_frame);
			return null;
		}

		// TODO(?): Do we need to consider the frame buffer to detect the pause text "properly"
		// TODO(?): check luma on level for better reliability (wity grey Gym rom)
		last_frame.gym_pause_active = !!(
			last_frame.gym_pause?.[1] &&
			last_frame.score &&
			last_frame.lines &&
			last_frame.level
		);

		if (--this.score_frame_delay > 0) {
			// just wait
		} else if (this.score_frame_delay === 0) {
			this.frame_buffer.forEach(frame => {
				frame.score = last_frame.score;
			});
		} else if (
			!last_frame.gym_pause_active &&
			!GameTracker.arrEqual(last_frame.score, peek(this.frame_buffer).score)
		) {
			this.score_frame_delay = this.frame_buffer.length;
		}

		if (--this.lines_frame_delay > 0) {
			// just wait
		} else if (this.lines_frame_delay === 0) {
			this.frame_buffer.forEach(frame => {
				frame.lines = last_frame.lines;
				frame.level = last_frame.level;
			});
		} else if (
			!last_frame.gym_pause_active &&
			!GameTracker.arrEqual(last_frame.lines, peek(this.frame_buffer).lines)
		) {
			this.lines_frame_delay = this.frame_buffer.length;
		}

		// mutually exclusive checks for piece checks based on selected rom (classic, das trainer, minimal)
		if (this.config.tasks.T) {
			// In classic rom, we have several way of determining the cur_piece
			// 1. on piece change, cur_piece is the previous preview
			// 2. on piece change, cur_piece if the piece with the last incremented counter
			// So... Should this populate the cur_piece? it's not OCR...
			// then again, the corrections are not really OCR too either
			// TODO: populate cur_piece into the frame for classic rom (maybe?)
			if (--this.piece_frame_delay > 0) {
				// just wait
			} else if (this.piece_frame_delay === 0) {
				this.frame_buffer.forEach(frame => {
					frame.preview = last_frame.preview;
					frame.T = last_frame.T;
					frame.J = last_frame.J;
					frame.Z = last_frame.Z;
					frame.O = last_frame.O;
					frame.S = last_frame.S;
					frame.L = last_frame.L;
					frame.I = last_frame.I;
				});
			} else if (
				!last_frame.gym_pause_active &&
				!GameTracker.pieceCountersEqual(last_frame, peek(this.frame_buffer))
			) {
				this.piece_frame_delay = this.frame_buffer.length;
			}
		} else if (this.config.tasks.instant_das) {
			// das trainer rom
			if (--this.piece_frame_delay > 0) {
				// just wait
			} else if (this.piece_frame_delay === 0) {
				this.frame_buffer.forEach(frame => {
					frame.preview = last_frame.preview;
					frame.cur_piece = last_frame.cur_piece;
					frame.cur_piece_das = last_frame.cur_piece_das;
				});
			} else {
				// note: no need to test for gym_pause_active in das trainer rom
				if (
					last_frame.preview != peek(this.frame_buffer).preview ||
					last_frame.cur_piece != peek(this.frame_buffer).cur_piece ||
					!GameTracker.arrEqual(
						last_frame.cur_piece_das,
						peek(this.frame_buffer).cur_piece_das
					)
				) {
					this.piece_frame_delay = this.frame_buffer.length;
				}
			}
		} else {
			// minimal trainer rom
			if (--this.piece_frame_delay > 0) {
				// just wait
			} else if (this.piece_frame_delay === 0) {
				this.frame_buffer.forEach(frame => {
					frame.preview = last_frame.preview;
				});
			} else {
				if (
					!last_frame.gym_pause_active &&
					last_frame.preview != peek(this.frame_buffer).preview
				) {
					this.piece_frame_delay = this.frame_buffer.length;
				}
			}
		}

		this.frame_buffer.push(last_frame);

		// ======= Now do OCR step 2: scan colors and field
		// Note: we need the level to read the field, so that's why we do after sanitize

		const raw_ocr_frame = this.frame_buffer.shift();
		const dispatch_frame = { ...raw_ocr_frame };

		if (dispatch_frame.gym_pause_active) {
			// On gym pause, we generate a fake vanilla-pause frame were everything is black
			dispatch_frame.score = null;
			dispatch_frame.lines = null;
			dispatch_frame.level = null;
			dispatch_frame.preview = null;

			if (this.config.tasks.T) {
				PIECES.forEach(p => (dispatch_frame[p] = null));
			}
		}

		// replicate NESTrisOCR's gameid logic
		// also check if the fixers must be reset
		if (
			dispatch_frame.gym_pause_active ||
			dispatch_frame.lines === null ||
			dispatch_frame.score === null ||
			dispatch_frame.level === null
		) {
			this.in_game = false;
		} else if (!this.in_game) {
			this.in_game = true;

			if (
				/* game start */
				(dispatch_frame.score.slice(0, -1).every(v => v === 0) &&
					(peek(dispatch_frame.score) === 1 ||
						peek(dispatch_frame.score) === 0) && // checks that score is 0 or 1; works for 6 and 7 digits scores
					(GameTracker.arrEqual(dispatch_frame.lines, [0, 0, 0]) || // mode A
						GameTracker.arrEqual(dispatch_frame.lines, [0, 2, 5]))) || // mode B
				this.cur_lines === undefined
			) {
				this.gameid = this.getNextGameId();

				this.score_fixer.reset();
				this.score_fixer.fix(dispatch_frame.score);

				this.cur_lines = GameTracker.digitsToValue(dispatch_frame.lines);
				this.start_level = GameTracker.digitsToValue(dispatch_frame.level);
				this.transition = TRANSITIONS[this.start_level];
				this.palette = Array(10).fill();

				if (this.config.tasks.T) {
					this.cur_T = GameTracker.digitsToValue(dispatch_frame.T);
					this.cur_J = GameTracker.digitsToValue(dispatch_frame.J);
					this.cur_Z = GameTracker.digitsToValue(dispatch_frame.Z);
					this.cur_O = GameTracker.digitsToValue(dispatch_frame.O);
					this.cur_S = GameTracker.digitsToValue(dispatch_frame.S);
					this.cur_L = GameTracker.digitsToValue(dispatch_frame.L);
					this.cur_I = GameTracker.digitsToValue(dispatch_frame.I);
				}

				if (!this.transition) {
					console.warn(
						`Unable to find transition lines for start level ${this.start_level}, set as 18-start.`
					);
					this.start_level = 18;
					this.transition = TRANSITIONS[18];
				}

				this.onNewGame(this.gameid);
			}
		}

		let lines;

		if (dispatch_frame.lines === null) {
			lines = null;
		} else if (this.cur_lines >= 340) {
			// Take over at level 40, which is after super kill screen (39) - Too bad for the harcoded value -_-'
			const new_lines_units = peek(dispatch_frame.lines);
			const cur_lines_units = this.cur_lines % 10;

			if (new_lines_units > cur_lines_units) {
				this.cur_lines += new_lines_units - cur_lines_units;
			} else if (new_lines_units < cur_lines_units) {
				this.cur_lines = Math.ceil(this.cur_lines / 10) * 10 + new_lines_units;
			}

			lines = this.cur_lines;
		} else {
			lines = this.cur_lines = GameTracker.digitsToValue(dispatch_frame.lines);
		}

		const level = this._getLevelFromLines(lines, dispatch_frame.level); // this is no longer OCR!

		const { field, color1, color2, color3 } =
			await this.tetris_ocr.processFrameStep2(dispatch_frame, level);

		if (level !== null) {
			// We compute a palette for the setup that can be saved later
			const level_unit = level % 10;

			// Note: gross code below which works by switching the type of the variable this.palette[level_unit]
			if (this.palette[level_unit] === undefined) {
				this.palette[level_unit] = BUFFER_MAXSIZE;
			} else if (!Array.isArray(this.palette[level_unit])) {
				if (--this.palette[level_unit] === 0) {
					// TODO: Run averages of the color data read from the field instead, over multiple frames
					// would be more accurate but more complex
					this.palette[level_unit] = [color1, color2, color3];

					if (this.palette.every(Array.isArray)) {
						this.onPalette();
					}
				}
			}
		}

		const pojo = {
			gameid: this.gameid,
			lines,
			level,
			preview: dispatch_frame.preview,
			gym_pause_active: dispatch_frame.gym_pause_active,
			field,
			color1,
			color2,
			color3,

			score: GameTracker.digitsToValue(
				this.score_fixer.fix(dispatch_frame.score)
			), // note: nulls are passthrough

			raw: {
				...raw_ocr_frame,
				field,
				color1,
				color2,
				color3,
			},
		};

		if (this.config.tasks.cur_piece_das) {
			pojo.instant_das = GameTracker.digitsToValue(dispatch_frame.instant_das);
			pojo.cur_piece_das = GameTracker.digitsToValue(
				dispatch_frame.cur_piece_das
			);
			pojo.cur_piece = dispatch_frame.cur_piece;
		}

		if (this.config.tasks.T) {
			PIECES.forEach(p => {
				let value;

				if (dispatch_frame[p] === null) {
					value = null;
				} else if (this[`cur_${p}`] >= 100) {
					const new_units = peek(dispatch_frame[p]);
					const cur_units = this[`cur_${p}`] % 10;

					if (new_units > cur_units) {
						this[`cur_${p}`] += new_units - cur_units;
					} else if (new_units < cur_units) {
						this[`cur_${p}`] =
							Math.ceil(this[`cur_${p}`] / 10) * 10 + new_units;
					}

					value = this[`cur_${p}`];
				} else {
					value = this[`cur_${p}`] = GameTracker.digitsToValue(
						dispatch_frame[p]
					);
				}

				pojo[p] = value;
			});
		}

		this.onMessage(pojo);
	}
}

GameTracker.digitsToValue = function digitsToValue(digits) {
	if (!digits) return null;

	return digits.reduce(
		(acc, v, idx) => acc + v * Math.pow(10, digits.length - idx - 1),
		0
	);
};

GameTracker.arrEqual = function arrEqual(arr1, arr2) {
	return (
		(arr1 === null && arr2 === null) ||
		(arr1 &&
			arr2 &&
			arr1.length === arr2.length &&
			arr1.every((v, i) => v === arr2[i]))
	);
};

GameTracker.pieceCountersEqual = function pieceCountersEqual(frame1, frame2) {
	return (
		GameTracker.arrEqual(frame1.T, frame2.T) &&
		GameTracker.arrEqual(frame1.J, frame2.J) &&
		GameTracker.arrEqual(frame1.Z, frame2.Z) &&
		GameTracker.arrEqual(frame1.O, frame2.O) &&
		GameTracker.arrEqual(frame1.S, frame2.S) &&
		GameTracker.arrEqual(frame1.L, frame2.L) &&
		GameTracker.arrEqual(frame1.I, frame2.I)
	);
};
