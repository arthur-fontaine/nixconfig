// Exits 0 while Command is held. Terminals keep Cmd to themselves, so Neovim
// asks macOS on a click to tell Cmd+click (go to definition) from a click.
#include <CoreGraphics/CoreGraphics.h>

int main(void) {
  CGEventFlags flags = CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState);
  return (flags & kCGEventFlagMaskCommand) ? 0 : 1;
}
