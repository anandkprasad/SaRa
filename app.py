import subprocess
import sys
import warnings
from PIL import Image
from transformers import BlipProcessor, BlipForConditionalGeneration
import torch

# -----------------------------
# SILENCE ALL WARNINGS & LOGS
# -----------------------------
warnings.filterwarnings("ignore")
import transformers
transformers.logging.set_verbosity_error()

# -----------------------------
# OPTIONAL PROMPT FROM CLI
# -----------------------------
prompt = sys.argv[1] if len(sys.argv) > 1 else None

# -----------------------------
# Capture image
# -----------------------------
subprocess.run(
    [
        "ffmpeg",
        "-y",
        "-f", "avfoundation",
        "-framerate", "30",
        "-i", "0",
        "-frames:v", "1",
        "photo.jpg"
    ],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL
)

# -----------------------------
# Load BLIP
# -----------------------------
processor = BlipProcessor.from_pretrained(
    "Salesforce/blip-image-captioning-base",
    use_fast=True
)

model = BlipForConditionalGeneration.from_pretrained(
    "Salesforce/blip-image-captioning-base"
)
model.eval()

# -----------------------------
# Load image
# -----------------------------
image = Image.open("photo.jpg").convert("RGB")

# -----------------------------
# SAFE CAPTIONING MODE
# -----------------------------
if prompt:
    # Guided captioning (best effort, not guaranteed)
    inputs = processor(image, prompt, return_tensors="pt")
else:
    # Pure image captioning (most stable)
    inputs = processor(image, return_tensors="pt")

with torch.no_grad():
    output_ids = model.generate(
        **inputs,
        max_new_tokens=40,
        num_beams=3,
        do_sample=False
    )

caption = processor.decode(
    output_ids[0],
    skip_special_tokens=True
).strip()

# -----------------------------
# SAFETY CHECK
# -----------------------------
if not caption or len(caption) < 5:
    caption = "I can see a person, but the details are unclear."

# -----------------------------
# CLEAN STDOUT FOR NODE
# -----------------------------
sys.stdout.write(caption)
sys.stdout.flush()
