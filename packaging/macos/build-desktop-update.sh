#!/bin/bash
# Build the unsigned per-user package that replaces only Pi Pocket.app.
# build.sh has already compiled and ad hoc signed the universal bundle.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
version="$1" out="$2" bundle="$3"
work="$(mktemp -d "${TMPDIR:-/tmp}/pi-pocket-desktop-update.XXXXXX")"
trap 'rm -rf "$work"' EXIT

mkdir "$work/root"
/usr/bin/ditto "$bundle" "$work/root/Pi Pocket.app"
scripts="$work/scripts"
cp -R "$here/scripts/desktop-update" "$scripts"
chmod 755 "$scripts/preinstall" "$scripts/postinstall"

# Put the bundle in a staging folder so Installer cannot relocate it over a running app.
pkgbuild --analyze --root "$work/root" "$work/components.plist"
plutil -replace 0.BundleIsRelocatable -bool false "$work/components.plist"
pkgbuild --root "$work/root" --component-plist "$work/components.plist" --scripts "$scripts" \
    --compression latest --min-os-version 13.5 \
    --identifier io.github.tannermidd.pi-pocket.desktop-update --version "$version" \
    --install-location '/Library/Application Support/Pi Pocket/desktop-update-payload' "$work/desktop-update.pkg"

sed -e "s/@VERSION@/$version/g" "$here/desktop-update.xml" > "$work/distribution.xml"
productbuild --distribution "$work/distribution.xml" --package-path "$work" \
    "$out/Pi-Pocket-Desktop-Update-$version.pkg"
