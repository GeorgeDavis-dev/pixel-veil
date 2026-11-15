# Pixel Veil

Pixel Veil hides parts of a photo. Open a photo and drag a rectangle over a face, some text or a licence plate. That area is pixelated, blurred or blacked out. Then save the result.

The photo never leaves your device. There is no upload, no account and no tracking. Once the app has loaded it works with no internet connection.

Built as a replacement for the workflow of the retiring Facepixelizer site. All code and content here are original.

## Two ways to use it

### The single file

Open `dist/pixel-veil.html` in a browser. A double-click is enough.

The whole app is inside that file, including the face detector. It needs no server and no connection. You can copy the file to a USB stick or keep it in a folder. It is about 17 MB, and most of that is the face detector.

### The installed app

Put this folder on a web host and open its address in a browser. The first visit downloads about 13 MB and saves every file on the device. After that the app opens with no connection.

To install the app:

- In Chrome or Edge on a computer, use the install button in the address bar.
- In Chrome on Android, open the menu and choose Add to Home screen.
- In Safari on iPhone or iPad, tap Share and choose Add to Home Screen.

To try the app on your own computer, run this in the project folder:

```
node tools/serve.mjs
```

Then open `http://127.0.0.1:8080/`. For another port, add the number, as in `node tools/serve.mjs 9000`.

## How it works

- Drag over an area to hide it. Auto, Pixelate, Blur and Black choose how the area is hidden. With the keyboard, Tab to the photo, place a box with the arrow keys and press Enter.
- Drag backwards, from bottom right to top left, to bring the original back in that area.
- Faces finds the faces in the photo and lets you pick which faces to hide. Small or turned faces can be missed, so check the result by eye.
- Crop, Undo and Revert do what they say. Save with a crop frame that is not applied yet asks you to press Apply or Cancel first.
- Save writes a JPEG or a PNG. The saved copy carries no metadata, so Exif data and GPS location are gone.

Blurred or pixelated text can sometimes be reconstructed. Use Black for anything truly sensitive.

### Several photos at once

Open or drop several photos and a filmstrip of small previews appears. Select more than one photo in the filmstrip and each edit is applied to every selected photo. Faces then goes through the selected photos one at a time, so you can pick the faces to hide in each photo.

Save can write this photo, the selected photos or all of them. Several photos are saved together as one ZIP file. An iPhone or iPad offers the share sheet first, with the ZIP as the other choice. Each photo is saved at its own original size.

The app remembers your tool, strength and format choices in this browser for next time. Photos are never stored.

The Help button in the app has the full guide and the keyboard shortcuts.

## Putting it on a web host

Any static host works, for example GitHub Pages, Netlify, Cloudflare Pages or your own server.

1. Run `node tools/build.mjs`.
2. Upload the whole folder. The app can sit in a sub-folder of a site.
3. Open the address over HTTPS. Browsers only allow install and offline use on HTTPS.

The host has to send `.wasm` files as `application/wasm`. The hosts named above do.

The app does not need `tools/` or `README.md` on the host. Keep `dist/` there if you want people to be able to download the single file.

## Rebuilding

Run this after you change any file:

```
node tools/build.mjs
```

The script needs Node.js and nothing else. It was tested with Node 24. It does two jobs:

- It writes a new cache version into `sw.js`. People who already have the app get the changed files the next time they open it online.
- It writes `dist/pixel-veil.html` again from `index.html`, `styles.css`, `zip.js`, `face.js`, `app.js` and the files in `vendor/`.

The script stops with an error and changes nothing if a file is missing or `index.html` has lost a tag the script looks for.

To change the icon, edit `icons/icon.svg`, then run `node tools/make-icons.mjs` to draw the PNG icons again.

## Privacy

- Your photo is opened, edited and saved inside your browser. The app sends it nowhere.
- The app has no analytics, no cookies and no accounts. It keeps your tool, strength and format choices in the browser, and nothing about your photos.
- The only network requests are for the app's own files, from the place the app is hosted. The single file makes no requests at all.
- A content security policy in the page blocks connections to any other site.

## Browsers

Pixel Veil is built for current versions of Chrome, Edge and Firefox. In Safari it needs version 16.4 or newer.

## Third-party licences

Face detection uses Google MediaPipe Tasks Vision (`@mediapipe/tasks-vision` 0.10.35) and the BlazeFace full-range face detection model. Both are under the Apache License 2.0.

Those files are in `vendor/mediapipe/`. The same folder has the licence text in `LICENSE`, and `NOTICE.md` lists where each file came from. The single file carries a copy of the licence as well.

Everything else in this project is original.
