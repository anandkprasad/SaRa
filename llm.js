const { exec } = require("child_process");

exec(
  "ffmpeg -f avfoundation -framerate 30 -i '0' -frames:v 1 photo.jpg",
  (err) => {
    if (err) console.error(err);
    else console.log("Photo captured");
  }
);
