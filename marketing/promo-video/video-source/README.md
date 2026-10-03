# Promo video source

`video.html` draws every frame of the promo video from the screenshots in `../mockups/` (scenes, camera moves, highlight boxes, captions and title cards are all in the `SCENES` list at the top). `render.js` steps through it at 24 fps in headless Chromium and pipes the frames to ffmpeg.

To re-render after editing a scene (needs Node, Playwright with Chromium, and ffmpeg):

    node render.js CoPublisher-AI-promo.mp4

For a vertical 9:16 phone version (screenshots zoomed in, camera follows each highlight):

    node render.js CoPublisher-AI-promo-vertical.mp4 --vertical

Open `video.html?v=1` in a browser to preview the vertical layout.

The video has captions but no voiceover or music; add those in your video tool or editor. All product numbers on screen are sample data.
