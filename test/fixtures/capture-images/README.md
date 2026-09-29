These are synthetic image validation fixtures with no user data.

- `static.png`, `static.jpg`, `static.webp`: a 2 × 3 red image encoded using
  `@imagemagick/magick-wasm` 0.0.43 (ImageMagick 7.1.2-30).
- `pixel-limit.png`: a 2000 × 2000 red image (exactly 4,000,000 pixels).
- `over-pixel-limit.png`: a 2001 × 2000 red image.
- `animated.webp`: two 2 × 3 frames, red and blue, encoded using the same library.
- `animated.png`: two 2 × 3 RGBA frames, red and blue, built with PNG chunks,
  zlib-compressed scanlines, valid CRCs, and APNG `acTL`/`fcTL`/`fdAT` chunks.

The large dimension PNGs are solid colors and occupy only a few KiB on disk.
Tests derive truncated/corrupt payloads in memory so the original fixtures stay valid.
