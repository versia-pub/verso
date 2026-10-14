{ pkgs }:

# Build step 1 spike: can the nixpkgs vips CLI do what the media queue needs, and how fast is it?
# Temporary. Its results go into docs/, and the images adapter tests replace it in build step 10.
pkgs.runCommand "media-spike"
  {
    nativeBuildInputs = [
      pkgs.vips
      pkgs.exiftool
      pkgs.time
    ];
  }
  ''
    set -euo pipefail
    mkdir $out
    log=$out/results.txt
    measure() {
      label=$1
      shift
      command time -a -o $log -f "  $label: %e s, peak %M KiB" "$@"
    }

    # A noise photo is the worst case for decoding. EXIF orientation 6 means "rotate 90° clockwise".
    photo() {
      vips gaussnoise noise.v $1 $2 --mean 128 --sigma 50
      vips bandjoin "noise.v noise.v noise.v" rgb.v
      vips cast rgb.v rgb8.v uchar
      vips copy rgb8.v "in.jpg[Q=90]" --interpretation srgb
      exiftool -q -overwrite_original -Orientation#=6 -GPSLatitude=48.85 -GPSLatitudeRef=N in.jpg
      test -n "$(exiftool -s3 -GPSLatitude in.jpg)"
    }

    for size in "1000 750" "4000 3000" "8000 6000"; do
      set -- $size
      photo $1 $2
      echo "JPEG $1x$2, $(du -k in.jpg | cut -f1) KiB:" >> $log

      measure "read dimensions" vipsheader -f width in.jpg > /dev/null
      measure "rotate upright and strip metadata" vips copy "in.jpg[autorotate]" "clean.jpg[keep=none,Q=90]"
      measure "100px thumbnail" vips thumbnail in.jpg thumb.v 100 --height 100
      vips addalpha thumb.v thumb-rgba.v
      vips rawsave thumb-rgba.v thumb.raw

      # The stripped copy is upright (taller than wide) and has no GPS position left.
      test "$(vipsheader -f width clean.jpg)x$(vipsheader -f height clean.jpg)" = "$2x$1"
      test -z "$(exiftool -s3 -GPSLatitude clean.jpg)"
      # Thumbhash wants upright RGBA pixels, at most 100 on each side.
      w=$(vipsheader -f width thumb-rgba.v)
      h=$(vipsheader -f height thumb-rgba.v)
      test "$h" -eq 100 -a "$w" -lt "$h"
      test "$(stat -c %s thumb.raw)" -eq $((w * h * 4))
    done

    # Other formats clients upload: they only need to decode.
    photo 1000 750
    vips copy rgb8.v in.png --interpretation srgb
    vips copy rgb8.v in.webp --interpretation srgb
    vips copy rgb8.v in.avif --interpretation srgb
    for format in png webp avif; do
      vips thumbnail in.$format thumb-$format.v 100 --height 100
    done
    echo "PNG, WebP and AVIF thumbnails: ok" >> $log

    cat $log
  ''
