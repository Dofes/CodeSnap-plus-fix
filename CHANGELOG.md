# Change Log

All notable changes to the "codesnap" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [1.1.0] - CodeSnap Plus Fast

- Copy and save are much faster: the snapshot is rendered from the page's stylesheet instead of inlining every computed style on every element (300 lines: about 22 s before, 0.4 s now)
- Long snippets work: the image is painted in bands and encoded as a streaming PNG, so it is no longer limited by the canvas size
- Images too large for the webview's clipboard are copied by the extension host with the system's own tools
- The save dialog opens immediately and the image renders in the meantime
- PNG files are about half as large
- Requires VS Code 1.57 or later

## [1.3.4]

- Fix issue where extension didn't work with `editor.copyWithSyntaxHighlighting: false`

## [1.3.3]

- Fixed issue with copy to clipboard in windows

## [1.3.2]

- Fixed issue with inconsistent start up

## [1.3.1]

- Fixed issue with screenshot margins

## [1.3.0]

- Add `shutterAction` option
- Fix issue with transparency on windows
- Fix auto width of snap shots

## [1.0.26]

- Update copy to clipboard permissions for OS X

## [1.0.20]

- Support `editor.fontLigatures: false`

## [1.0.19]

- Fixed some issues with generated images

## [1.0.18]

- Added command in right click context menu

## [1.0.14]

- Added usage instructions to readme

## [1.0.13]

- Fixed font rendering issues with certain font settings

## [1.0.9]

- Fixed issues when using language specific settings

## [1.0.8]

- Fixed line number alignment on narrow screen

## [1.0.7]

- Fixed render issue with line numbers

## [1.0.6]

- Fixed render issue when saving on certain VS Code configurations

## [1.0.0]

- Initial release
