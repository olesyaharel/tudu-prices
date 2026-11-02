#!/bin/zsh
# Carrefour, Hatzi Hinam, Victory, Mahsanei HaShuk, H. Cohen and Netiv HaHesed refuse servers abroad, so a computer in Israel fetches them every morning (launchd, see
# il.tudu.prices.plist) and leaves the result as the file local.tgz on the GitHub release "israel"; the nightly job there
# folds it in (job.mjs --merge). Locations are left to that job, so geocode.json stays its alone.
set -e
cd "${0:A:h}"
GH=./tools-dl/gh_2.103.3_macOS_arm64/bin/gh
echo "--- $(date)"
rm -rf local-out
node job.mjs --chains=carrefour,hazihinam,victory,mshuk,hcohen,netivhesed --out=local-out --no-locate
tar czf local.tgz -C local-out .
$GH release upload israel local.tgz --clobber
echo "uploaded $(du -h local.tgz | cut -f1)"
