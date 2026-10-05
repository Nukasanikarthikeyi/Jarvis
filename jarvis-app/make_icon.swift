// Draws the JARVIS HUD app icon — the reactor rings from the HUD — into an
// .iconset folder for iconutil. Used by jarvis-app/build.sh.
//
//   make_icon <folder.iconset>

import Cocoa

let cyan = NSColor(red: 0.098, green: 0.910, blue: 0.949, alpha: 1)
let hot = NSColor(red: 0.624, green: 0.973, blue: 1.0, alpha: 1)

func arc(_ centre: NSPoint, _ radius: CGFloat, from: CGFloat, to: CGFloat, width: CGFloat,
         _ colour: NSColor) {
    let path = NSBezierPath()
    path.appendArc(withCenter: centre, radius: radius, startAngle: from, endAngle: to)
    path.lineWidth = width
    path.lineCapStyle = .butt
    colour.setStroke()
    path.stroke()
}

func draw(_ side: CGFloat) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(side), pixelsHigh: Int(side),
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

    // the rounded tile macOS icons sit on
    let inset = side * 0.09
    let tile = NSRect(x: inset, y: inset, width: side - inset * 2, height: side - inset * 2)
    let shape = NSBezierPath(roundedRect: tile, xRadius: tile.width * 0.225, yRadius: tile.width * 0.225)
    NSGradient(colors: [NSColor(red: 0.04, green: 0.30, blue: 0.38, alpha: 1),
                        NSColor(red: 0.008, green: 0.05, blue: 0.075, alpha: 1),
                        NSColor(red: 0.004, green: 0.024, blue: 0.039, alpha: 1)],
               atLocations: [0, 0.6, 1], colorSpace: .deviceRGB)!
        .draw(in: shape, relativeCenterPosition: .zero)
    shape.lineWidth = max(1, side * 0.008)
    cyan.withAlphaComponent(0.45).setStroke()
    shape.stroke()

    let c = NSPoint(x: side / 2, y: side / 2)
    let r = tile.width / 2
    // thick ring with a gap, the HUD's gauge
    arc(c, r * 0.70, from: 0, to: 360, width: r * 0.115, cyan.withAlphaComponent(0.22))
    arc(c, r * 0.70, from: 118, to: 30, width: r * 0.115, cyan)
    // fine rings and the red arc from the reactor frame
    arc(c, r * 0.86, from: 0, to: 360, width: max(1, r * 0.012), cyan.withAlphaComponent(0.55))
    arc(c, r * 0.52, from: 0, to: 360, width: max(1, r * 0.012), cyan.withAlphaComponent(0.6))
    arc(c, r * 0.60, from: 135, to: 185, width: max(1, r * 0.03),
        NSColor(red: 1, green: 0.27, blue: 0.27, alpha: 0.95))
    if side >= 64 {                                     // tick scale, too fine for the small sizes
        for i in 0..<48 {
            let a = CGFloat(i) / 48 * 2 * .pi
            let long: CGFloat = i % 4 == 0 ? 0.80 : 0.83
            let tick = NSBezierPath()
            tick.move(to: NSPoint(x: c.x + cos(a) * r * long, y: c.y + sin(a) * r * long))
            tick.line(to: NSPoint(x: c.x + cos(a) * r * 0.855, y: c.y + sin(a) * r * 0.855))
            tick.lineWidth = max(0.5, r * 0.008)
            cyan.withAlphaComponent(0.5).setStroke()
            tick.stroke()
        }
    }
    // the core
    let core = NSRect(x: c.x - r * 0.34, y: c.y - r * 0.34, width: r * 0.68, height: r * 0.68)
    NSGradient(colors: [.white, hot, cyan, cyan.withAlphaComponent(0)],
               atLocations: [0, 0.28, 0.6, 1], colorSpace: .deviceRGB)!
        .draw(in: NSBezierPath(ovalIn: core), relativeCenterPosition: .zero)

    NSGraphicsContext.restoreGraphicsState()
    return rep
}

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write("usage: make_icon <folder.iconset>\n".data(using: .utf8)!)
    exit(2)
}
let folder = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
for (name, side) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64),
                     ("128x128", 128), ("128x128@2x", 256), ("256x256", 256),
                     ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
    let png = draw(CGFloat(side)).representation(using: .png, properties: [:])!
    try png.write(to: folder.appendingPathComponent("icon_\(name).png"))
}
