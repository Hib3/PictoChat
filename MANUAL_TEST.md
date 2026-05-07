# Manual Test

1. Open `https://hib3.github.io/PictoChat/` in two private browser windows.
2. Log in with different usernames and choose Chat Room A in both windows.
3. Confirm the room list/player count changes when the second user joins, and the first user sees the join notice in about one second.
4. From the first PC window, type and send:
   - `こんにちは`
   - `漢字変換`
   - `abcこんにちは123`
5. Confirm each message appears in the second window in about one second.
6. Open the same page on a smartphone, log in, and join Chat Room A.
7. Confirm Chat Room A shows three users.
8. Draw a line in the input canvas and confirm handwriting still works.
9. Tap the `KEY` button at the lower right, enter Japanese text with the phone keyboard, and send it.
10. Confirm the other windows receive the smartphone message in about one second.
11. Open DevTools Console and confirm `[PictoChat] joinRoom`, `subscribe start`, `presence sent`, `presence received`, `message sent`, and `message received` logs appear.
