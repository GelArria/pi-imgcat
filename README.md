# pi-imgcat

Show images inline in the [pi](https://pi.dev) terminal.

## Install

```powershell
pi install git:github.com/GelArria/pi-imgcat
# optional, for real Sixel in Windows Terminal:
Install-Module Sixel -Scope CurrentUser -Force
```

Then `/reload` in pi. Or just copy this folder to `~/.pi/agent/extensions/pi-imgcat/`.

## Usage

```
> show me C:\Users\me\Pictures\shot.png   # the LLM calls show_image
> /img %TEMP%\plot.png                    # manual, no LLM turn
```

Accepts local paths, `http(s)://` URLs, and `data:` URIs. The image is also sent to the model, so you can ask about it.

## Rendering

| Terminal | How |
|---|---|
| iTerm2, Kitty, WezTerm, Ghostty | native inline image (~60 cells wide) |
| Windows Terminal (direct) | Sixel (needs the `Sixel` PowerShell module) |
| Multiplexers (Herdr, tmux) or anything else | ANSI half-blocks — plain text, works everywhere |

Over SSH from iTerm2, run `$env:PI_IMAGE_PROTOCOL='iterm2'` before `pi` (iTerm doesn't forward its session id).

No npm dependencies. Sixel helpers adapted from [pi-image-tools](https://github.com/MasuRii/pi-image-tools) (MIT). License: MIT.