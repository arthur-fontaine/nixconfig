// quicklook <file>: shows the file in the Quick Look panel and quits once the
// panel closes. Unlike `qlmanage -p`, it has no Dock icon (an accessory app)
// and opens on the display under the pointer instead of the main one.
import AppKit
import Quartz

guard CommandLine.arguments.count == 2 else {
  FileHandle.standardError.write(Data("usage: quicklook <file>\n".utf8))
  exit(2)
}
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let isDebug = ProcessInfo.processInfo.environment["QUICKLOOK_DEBUG"] != nil

final class Controller: NSObject, NSApplicationDelegate, QLPreviewPanelDataSource {
  private var hasShown = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    guard let panel = QLPreviewPanel.shared() else { exit(1) }
    NSApp.activate(ignoringOtherApps: true)
    center(panel)
    panel.makeKeyAndOrderFront(nil)
    // The panel places itself as it opens, so move it again once it's up.
    DispatchQueue.main.async { self.center(panel) }
  }

  private func center(_ panel: QLPreviewPanel) {
    let pointer = NSEvent.mouseLocation
    guard let screen = NSScreen.screens.first(where: { NSMouseInRect(pointer, $0.frame, false) }) else { return }
    let visible = screen.visibleFrame
    var frame = panel.frame
    frame.origin = NSPoint(x: visible.midX - frame.width / 2, y: visible.midY - frame.height / 2)
    panel.setFrame(frame, display: true)
    if isDebug {
      FileHandle.standardError.write(Data("pointer \(pointer) screen \(screen.frame) panel \(panel.frame)\n".utf8))
    }
  }

  // The panel looks for its controller along the responder chain, which ends
  // with the app's delegate.
  override func acceptsPreviewPanelControl(_ panel: QLPreviewPanel!) -> Bool { true }

  override func beginPreviewPanelControl(_ panel: QLPreviewPanel!) {
    panel.dataSource = self
    hasShown = true
  }

  // Esc, space or the close button hide the panel without closing it.
  override func endPreviewPanelControl(_ panel: QLPreviewPanel!) {
    if hasShown { NSApp.terminate(nil) }
  }

  func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int { 1 }

  func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> QLPreviewItem! {
    url as NSURL
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = Controller()
app.delegate = controller
app.run()
