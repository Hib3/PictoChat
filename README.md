# PictoChat PWA

Small static PWA inspired by PictoChat-style group chat for private, non-commercial use.

## Features

- Four rooms: A, B, C, D
- Username-only entry
- Random user color
- Group chat only
- Text and drawing messages
- No backend server
- No offline message storage

## GitHub Pages

This repository is ready to publish from GitHub Pages as a static site.

Recommended settings:

1. Open `Settings` > `Pages`.
2. Set `Source` to `Deploy from a branch`.
3. Set `Branch` to `main` and folder to `/root`.
4. Save.

After GitHub finishes publishing, the app URL should be:

https://hib3.github.io/PictoChat/

The app is static. WebRTC peer discovery uses Trystero's torrent strategy, so initial connection still needs internet access.

## Notes

This project does not include Nintendo assets or original PictoChat code. It is a small web UI inspired by the look and flow of PictoChat.
