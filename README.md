# About

OCR Speedup Proof-of concept for NTC

# Configuration

Some behaviors can be configured from the following query string:

- impl: OCR implementation
  - original: NTC original
  - gpu: gpu-accelated, requires WebGL2
  - cpu: Reference implementation. Same method as gpu, but uses only CPU and canvas
- show_sheet: Show sheet
  - 1: Display sprite sheet at the bottom, only effective for gpu/cpu implementation
- config: Specify configuration name
  - (name): Configuration name, for default configuration leave it blank or set to `config`

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

browse http://localhost:3000/ocr/ocr
