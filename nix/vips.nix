{
  lib,
  vips,
  libheif,
  gdk-pixbuf,
  glib,
  libxml2,
  expat,
  cgif,
  lcms2,
  libexif,
  libhwy,
  libimagequant,
  libjpeg,
  libpng,
  libultrahdr,
  libwebp,
}:

let
  # libheif without its gdk-pixbuf loader, which only desktop programs use.
  libheif' = libheif.overrideAttrs (old: {
    buildInputs = lib.remove gdk-pixbuf old.buildInputs;
  });
in
# vips with only the libraries for the formats Verso reads and writes: JPEG (including Ultra HDR),
# PNG, WebP, GIF, AVIF and HEIC, and for colour profiles and EXIF orientation. nixpkgs's has
# ImageMagick, Poppler, librsvg, OpenEXR and more, which double its size. The dev shell and the
# tests use this one too, so they process pictures as Verso does.
(vips.override {
  withIntrospection = false;
  withDevDoc = false;
  imagemagick = null;
}).overrideAttrs
  (old: {
    buildInputs = [
      glib
      libxml2
      expat
      cgif
      lcms2
      libexif
      libheif'
      libhwy
      libimagequant
      libjpeg
      libpng
      libultrahdr
      libwebp
    ];

    # nixpkgs's meson requires every feature it isn't told to leave out.
    mesonFlags =
      old.mesonFlags
      ++ map (feature: lib.mesonEnable feature false) [
        "archive"
        "cfitsio"
        "fftw"
        "fontconfig"
        "jpeg-xl"
        "matio"
        "openexr"
        "openjpeg"
        "openslide"
        "orc"
        "pangocairo"
        "poppler"
        "quantizr"
        "raw"
        "rsvg"
        "tiff"
      ];
  })
