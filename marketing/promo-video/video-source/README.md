# Promo video source

`video.html` draws every frame of the promo video from the screenshots in `../mockups/` (scenes, camera moves, highlight boxes, captions and title cards are all in the `SCENES` list at the top). `render.js` steps through it at 24 fps in headless Chromium and pipes the frames to ffmpeg.

To re-render after editing a scene (needs Node, Playwright with Chromium, and ffmpeg):

    node render.js CoPublisher-AI-promo.mp4

The video has captions but no voiceover or music; add those in your video tool or editor. All product numbers on screen are sample data.
