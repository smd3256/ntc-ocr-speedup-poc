# About

OCR Speedup Proof-of concept for NTC

# Configuration

Some behaviors can be configured from the following query string:

- impl: OCR implementation
  - original: NTC original
  - gpu: gpu-accelated scaling, requires WebGL2
  - gpu_sync: gpu + sync pixel readback, performs better on Firefox
  - cpu: Reference implementation. Same method as gpu, but uses only CPU and canvas
- direct: Change video transfer method
  - 1: Directly pass video elem to OCR
  - 0: Pass via ImageBitmap (original method)
- config: Specify configuration name
  - (name): Configuration name, for default configuration leave it blank or set to `default`

Some query string might be useful for debugging:

- show_sheet: Show sheet
  - 1: Display sprite sheet at the bottom, only effective for gpu/cpu implementation

# Local dev

## Install dependencies

```
npm install
```

## Run server

```
npx serve src
```

## Run browser

Open http://localhost:3000/ocr/ocr (Chrome recommended)

# License

MIT

Please note that most of the code comes from nestrischamps ( https://github.com/timotheeg/nestrischamps ), and thus such parts are copyrighted by the NTC developers.
