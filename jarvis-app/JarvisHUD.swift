// JARVIS HUD — the HUD in a window of its own.
//
// Starts the JARVIS server if it is not already running, shows it in a web
// view, and stops the server again on quit (only if this app was the one that
// started it). Built by jarvis-app/build.sh; no Xcode project, no dependencies.
//
// A standalone build carries the server, the interface and a sample vault
// inside the app, and keeps everything that changes — settings, vault, memory —
// in ~/Library/Application Support/JARVIS HUD, never inside the bundle.

import Cocoa
import WebKit

let environment = ProcessInfo.processInfo.environment

/// The copy of JARVIS a standalone build carries.
let bundledPath = (Bundle.main.resourcePath ?? "") + "/jarvis"

/// The folder holding server.py and start.sh: the project a linked build was
/// made from (Info.plist), or the copy inside the app.
let projectPath: String = {
    if let p = environment["JARVIS_PROJECT"], !p.isEmpty { return p }
    if let p = Bundle.main.object(forInfoDictionaryKey: "JarvisProjectPath") as? String, !p.isEmpty { return p }
    return bundledPath
}()

/// Where settings, vault and memory live. A linked build keeps them in the
/// project folder; a standalone one keeps them outside the app.
let dataPath: String = {
    if let p = environment["JARVIS_HOME"], !p.isEmpty { return p }
    if projectPath == bundledPath { return NSHomeDirectory() + "/Library/Application Support/JARVIS HUD" }
    return projectPath
}()
let keepsDataApart = dataPath != projectPath
let settingsPath = dataPath + "/.env"

/// JARVIS_PORT from the settings file, the same place the server reads it.
func configuredPort() -> Int {
    guard let env = try? String(contentsOfFile: settingsPath, encoding: .utf8) else { return 8720 }
    for line in env.split(separator: "\n") {
        let parts = line.trimmingCharacters(in: .whitespaces).split(separator: "=", maxSplits: 1)
        if parts.count == 2, parts[0] == "JARVIS_PORT", let port = Int(parts[1].trimmingCharacters(in: .whitespaces)) {
            return port
        }
    }
    return 8720
}

/// First launch of a standalone build: a settings file and the sample vault,
/// so there is something to see and somewhere to put a voice key. Anything
/// already there is left exactly as it is.
func prepareData() {
    guard keepsDataApart else { return }
    let files = FileManager.default
    try? files.createDirectory(atPath: dataPath, withIntermediateDirectories: true)
    if !files.fileExists(atPath: settingsPath) {
        try? files.copyItem(atPath: projectPath + "/jarvis-app/app.env", toPath: settingsPath)
        try? files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: settingsPath)
    }
    if !files.fileExists(atPath: dataPath + "/vault") {
        try? files.copyItem(atPath: projectPath + "/vault", toPath: dataPath + "/vault")
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var web: WKWebView!
    private var notice: NSTextField!
    private var server: Process?          // set only when this app started the server
    private var port = 8720
    private let logURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/JARVIS HUD/server.log")

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        buildWindow()
        guard FileManager.default.fileExists(atPath: projectPath + "/start.sh") else {
            say("JARVIS was not found at\n\(projectPath)\n\nRebuild the app from the project with jarvis-app/build.sh.")
            return
        }
        prepareData()
        port = configuredPort()
        if serverIsUp() {
            load()
        } else {
            startServer()
            waitForServer(until: Date().addingTimeInterval(45))
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ note: Notification) { stopServer() }

    // MARK: server

    private func serverIsUp() -> Bool {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/status")!)
        request.timeoutInterval = 1.5
        let done = DispatchSemaphore(value: 0)
        var up = false
        URLSession.shared.dataTask(with: request) { _, response, _ in
            up = (response as? HTTPURLResponse)?.statusCode == 200
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 2)
        return up
    }

    private func startServer() {
        say("Starting JARVIS…")
        try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        let home = NSHomeDirectory()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [projectPath + "/start.sh"]
        process.currentDirectoryURL = URL(fileURLWithPath: projectPath)
        // A deliberately small environment: nothing from a parent shell, and in
        // particular no ANTHROPIC_API_KEY, so Claude stays on the subscription.
        var env = [
            "HOME": home, "USER": NSUserName(), "LOGNAME": NSUserName(),
            "SHELL": "/bin/zsh", "LANG": "en_US.UTF-8",
            "PATH": "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "PYTHONUNBUFFERED": "1",
            "PYTHONDONTWRITEBYTECODE": "1",   // never write .pyc files into the app
            "JARVIS_OPEN": "0",               // this window is the browser
        ]
        if keepsDataApart {
            env["JARVIS_HOME"] = dataPath     // settings, vault and memory
            env["JARVIS_WORKDIR"] = dataPath  // and where Claude itself runs
        }
        process.environment = env
        if let log = try? FileHandle(forWritingTo: logURL) {
            process.standardOutput = log
            process.standardError = log
        }
        do {
            try process.run()
            server = process
        } catch {
            say("Could not start JARVIS:\n\(error.localizedDescription)")
        }
    }

    private func stopServer() {
        // start.sh execs python, so this is the server itself; the claude
        // process it keeps warm exits when its stdin closes.
        guard let running = server, running.isRunning else { return }
        running.terminate()
        let deadline = Date().addingTimeInterval(3)
        while running.isRunning && Date() < deadline { usleep(50_000) }
        server = nil
    }

    private func waitForServer(until deadline: Date) {
        DispatchQueue.global().async {
            while Date() < deadline {
                if self.serverIsUp() {
                    DispatchQueue.main.async { self.load() }
                    return
                }
                if let server = self.server, !server.isRunning { break }
                usleep(300_000)
            }
            DispatchQueue.main.async {
                let tail = (try? String(contentsOf: self.logURL, encoding: .utf8))?
                    .split(separator: "\n").suffix(6).joined(separator: "\n") ?? ""
                self.say("JARVIS did not come up. It needs Python 3 on this Mac\n(xcode-select --install provides it).\n\n\(tail)\n\nFull log: \(self.logURL.path)")
            }
        }
    }

    private func load() {
        notice.isHidden = true
        web.isHidden = false
        web.load(URLRequest(url: URL(string: "http://localhost:\(port)")!))
    }

    private func say(_ text: String) {
        notice.stringValue = text
        notice.isHidden = false
    }

    // MARK: window

    private func buildWindow() {
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let size = NSSize(width: min(1480, visible.width * 0.92), height: min(920, visible.height * 0.92))
        window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "JARVIS"
        window.minSize = NSSize(width: 1040, height: 660)
        window.backgroundColor = NSColor(red: 0.004, green: 0.024, blue: 0.039, alpha: 1)
        window.appearance = NSAppearance(named: .darkAqua)
        window.center()
        window.setFrameAutosaveName("JarvisHUD")

        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []     // JARVIS speaks unprompted
        web = WKWebView(frame: window.contentView!.bounds, configuration: config)
        web.autoresizingMask = [.width, .height]
        web.uiDelegate = self
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")           // no white flash before the page paints
        web.isHidden = true
        window.contentView!.addSubview(web)

        notice = NSTextField(wrappingLabelWithString: "")
        notice.alignment = .center
        notice.textColor = NSColor(red: 0.1, green: 0.91, blue: 0.95, alpha: 1)
        notice.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        notice.frame = window.contentView!.bounds.insetBy(dx: 80, dy: 120)
        notice.autoresizingMask = [.width, .height]
        notice.isHidden = true
        window.contentView!.addSubview(notice)

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About JARVIS HUD", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Claude Account…", action: #selector(showAccount(_:)), keyEquivalent: "l")
        appMenu.addItem(withTitle: "Edit Settings…", action: #selector(editSettings(_:)), keyEquivalent: ",")
        appMenu.addItem(withTitle: "Open Data Folder", action: #selector(openDataFolder(_:)), keyEquivalent: "")
        let restart = appMenu.addItem(withTitle: "Restart JARVIS", action: #selector(restart(_:)), keyEquivalent: "r")
        restart.keyEquivalentModifierMask = [.command, .shift]
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide JARVIS HUD", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit JARVIS HUD", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        // Without an Edit menu, Cmd-C / Cmd-V do nothing in the ask box.
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload(_:)), keyEquivalent: "r")
        viewItem.submenu = view
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }

    @objc private func reload(_ sender: Any?) {
        if serverIsUp() { load() } else if server == nil || server?.isRunning == false {
            startServer()
            waitForServer(until: Date().addingTimeInterval(45))
        }
    }

    /// Settings are read when the server starts, so a change needs this.
    @objc private func restart(_ sender: Any?) {
        guard server != nil else { reload(sender); return }   // someone else's server: just reconnect
        web.isHidden = true
        stopServer()
        port = configuredPort()
        startServer()
        waitForServer(until: Date().addingTimeInterval(45))
    }

    @objc private func showAccount(_ sender: Any?) {
        web.evaluateJavaScript("typeof Account !== 'undefined' && Account.open()", completionHandler: nil)
    }

    @objc private func openDataFolder(_ sender: Any?) {
        NSWorkspace.shared.open(URL(fileURLWithPath: dataPath))
    }

    @objc private func editSettings(_ sender: Any?) {
        let textEdit = URL(fileURLWithPath: "/System/Applications/TextEdit.app")
        NSWorkspace.shared.open([URL(fileURLWithPath: settingsPath)], withApplicationAt: textEdit,
                                configuration: NSWorkspace.OpenConfiguration(), completionHandler: nil)
    }

    // MARK: web view

    /// Live voice needs the microphone. The page is this Mac's own JARVIS, so
    /// it is granted without a second in-page prompt; macOS still asks once.
    @available(macOS 12.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(["localhost", "127.0.0.1"].contains(origin.host) ? .grant : .deny)
    }

    /// Only JARVIS loads in this window; any other link goes to the browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, let host = url.host, !["localhost", "127.0.0.1"].contains(host) {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    /// target="_blank" links (the sign-in page) ask for a new window: send
    /// them to the browser instead of opening nothing.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        web.isHidden = true
        say("Could not reach JARVIS on port \(port).\n\(error.localizedDescription)\n\nPress ⌘R to try again.")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Build check: JARVIS_HUD_SELFTEST=<file> writes what the page can do
        // in this web view, so the build can be verified without looking at it.
        // JARVIS_HUD_SELFTEST_SAY=<line> also sends that line and records
        // whether its reply was actually played, near-silently.
        guard let out = environment["JARVIS_HUD_SELFTEST"], !out.isEmpty else { return }
        var wait = 5.0
        if let line = environment["JARVIS_HUD_SELFTEST_SAY"], !line.isEmpty,
           let quoted = try? JSONEncoder().encode(line), let literal = String(data: quoted, encoding: .utf8) {
            wait = Double(environment["JARVIS_HUD_SELFTEST_WAIT"] ?? "") ?? 16.0
            let speak = """
            (function () {
              var log = window.__hudAudio = [], t0 = performance.now(), play = HTMLMediaElement.prototype.play;
              HTMLMediaElement.prototype.play = function () {
                var el = this; el.volume = 0.001;
                ['playing', 'waiting', 'ended', 'error'].forEach(function (n) {
                  el.addEventListener(n, function () { log.push(n + '@' + Math.round(performance.now() - t0) + ' t=' + el.currentTime.toFixed(1)); });
                });
                return play.apply(el, arguments);
              };
              if (window.speechSynthesis) {            // the built-in voice, when there is no Fish key
                var say = speechSynthesis.speak.bind(speechSynthesis);
                speechSynthesis.speak = function (u) { u.volume = 0; log.push('builtin-voice@' + Math.round(performance.now() - t0)); return say(u); };
              }
              setTimeout(function () { transmit(\(literal)); }, 2500);
            })()
            """
            webView.evaluateJavaScript(speak, completionHandler: nil)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) {
            let probe = """
            JSON.stringify({ title: document.title,
              audio: window.__hudAudio || null,
              reply: typeof answerText !== 'undefined' ? answerText : null,
              voiceState: document.querySelector('#voiceState').textContent,
              account: typeof Account !== 'undefined' && Account.info ? { installed: Account.info.installed, signed_in: Account.info.signed_in, plan: Account.info.plan } : null,
              accountPanelOpen: !document.querySelector('#account').hidden,
              brainPill: document.querySelector('#pBrain').textContent,
              voicePill: document.querySelector('#pVoice').textContent,
              log: Array.prototype.slice.call(document.querySelectorAll('#log .entry'), 0, 6).map(function (e) { return e.textContent.slice(0, 80); }),
              canStream: typeof CAN_STREAM !== 'undefined' ? CAN_STREAM : null,
              mseMp3: !!(window.MediaSource && MediaSource.isTypeSupported('audio/mpeg')),
              getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
              mediaRecorder: typeof MediaRecorder !== 'undefined',
              serverVoice: window.__serverVoice, serverSTT: window.__serverSTT,
              gateway: document.querySelector('#pGateway').textContent,
              nodes: window.__jarvisGraph ? window.__jarvisGraph.nodes.length : null,
              scale: window.__jarvisGraph ? Math.round(window.__jarvisGraph.scale * 100) / 100 : null,
              matrix: document.querySelectorAll('#matrix .mcell').length,
              days: document.querySelectorAll('#dayStrip span').length,
              inner: innerWidth + 'x' + innerHeight })
            """
            webView.evaluateJavaScript(probe) { value, error in
                let text = (value as? String) ?? "{\"error\": \"\(error?.localizedDescription ?? "no value")\"}"
                try? text.write(toFile: out, atomically: true, encoding: .utf8)
                if environment["JARVIS_HUD_SELFTEST_QUIT"] == "1" {
                    NSApp.terminate(nil)
                }
            }
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
