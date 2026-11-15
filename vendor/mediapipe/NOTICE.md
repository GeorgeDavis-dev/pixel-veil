# Third-party files in this folder

Pixel Veil's optional "Faces" button uses Google's **MediaPipe Face Detector**.
Everything it needs is stored here and loaded from this folder (or, in the
single-file build, from inside the HTML file). Nothing is downloaded at run time.

All four files are redistributed **unmodified** under the
**Apache License, Version 2.0** — the full text is in [`LICENSE`](LICENSE) next
to this file. Copyright The MediaPipe Authors.

## Library: `@mediapipe/tasks-vision` 0.10.35

- Project: MediaPipe — <https://github.com/google-ai-edge/mediapipe>
- Package: <https://www.npmjs.com/package/@mediapipe/tasks-vision/v/0.10.35>
- Tarball: <https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.35.tgz>
  (sha256 `84597a25e13d123b5f4cbe768bb72e97a2c28c7a465f0ace287d8cbe5246bff0`)
- Licence: Apache-2.0 (as declared in the package's `package.json`)

| File here | File in the package | Bytes | sha256 |
| --- | --- | ---: | --- |
| `vision_bundle.js` | `vision_bundle.mjs` | 136,993 | `55d7ab624fbb70dcc5adc4ae6d7ea9cfcb569139d3dbfbf2b1deafcb966bc0fe` |
| `wasm/vision_wasm_internal.js` | `wasm/vision_wasm_internal.js` | 322,044 | `e7fd9858e8e8f221d9b96eddc11f8e077f263e0b7bbd79d3cbe882b134274f8c` |
| `wasm/vision_wasm_internal.wasm` | `wasm/vision_wasm_internal.wasm` | 11,153,617 | `6a5c64584c2ab61c763b6e204afbdbc7ce1caf7f5216187322bca8df94f646bc` |

What each one is:

- **`vision_bundle.js`** — the JavaScript API of MediaPipe's vision tasks as an
  ES module (exports `FaceDetector` among others). The only change is the file
  name: `.mjs` became `.js` so that any static host serves it with a JavaScript
  MIME type. The contents are byte-for-byte the published file.
- **`wasm/vision_wasm_internal.js`** — the Emscripten loader for the
  WebAssembly runtime. It defines a global `ModuleFactory`, which the bundle
  picks up after adding this file to the page as a script.
- **`wasm/vision_wasm_internal.wasm`** — the WebAssembly runtime (the SIMD
  build). It is compiled by Google from the MediaPipe sources and statically
  includes other open-source components, among them TensorFlow Lite and
  XNNPACK, which carry their own licences; see the MediaPipe repository for
  details.

Not shipped: the package's non-SIMD build (`vision_wasm_nosimd_internal.*`) and
its ES-module build (`vision_wasm_module_internal.*`). `face.js` passes the two
`wasm/` paths to MediaPipe directly, so those variants are never requested.
Every browser Pixel Veil supports has WebAssembly SIMD.

`vision_bundle.js` ends with a `//# sourceMappingURL=vision_bundle_mjs.js.map`
comment. The map is not part of this folder; browsers only ask for it while
developer tools are open, and the failed lookup is harmless.

## Model: BlazeFace, full range

| File here | Bytes | sha256 |
| --- | ---: | --- |
| `face_detection_full_range.tflite` | 1,083,786 | `3698b18f063835bc609069ef052228fbe86d9c9a6dc8dcb7c7c2d69aed2b181b` |

- Source: <https://storage.googleapis.com/mediapipe-assets/face_detection_full_range.tflite>
- Licence: Apache-2.0, published by Google as part of MediaPipe
- A TensorFlow Lite face detection model (192 × 192 input) meant for faces at
  some distance from the camera, which suits group photos better than the
  short-range variant.

## Checking the files

From the project root:

```
sha256sum vendor/mediapipe/vision_bundle.js \
          vendor/mediapipe/wasm/vision_wasm_internal.js \
          vendor/mediapipe/wasm/vision_wasm_internal.wasm \
          vendor/mediapipe/face_detection_full_range.tflite
```

(On Windows: `Get-FileHash -Algorithm SHA256 <file>`.) The output should match
the tables above.

## Updating

Replace the three library files with the same-named files from a newer
`@mediapipe/tasks-vision` release (renaming `vision_bundle.mjs` to
`vision_bundle.js`), update the version and checksums in this file, run
`node tools/build.mjs`, and check that the Faces button still works both from a
web server and from `dist/pixel-veil.html` opened straight from disk.
