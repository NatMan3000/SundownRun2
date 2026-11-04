import XCTest
final class RigTests: XCTestCase {
  func env(_ k: String) -> Double { Double(ProcessInfo.processInfo.environment[k] ?? "0") ?? 0 }
  func safari() -> XCUIApplication { let a = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari"); a.activate(); return a }
  func testLandscapeLeft() { _ = safari(); XCUIDevice.shared.orientation = .landscapeLeft; sleep(2) }
  func testLandscapeRight() { _ = safari(); XCUIDevice.shared.orientation = .landscapeRight; sleep(2) }
  func testPortrait() { _ = safari(); XCUIDevice.shared.orientation = .portrait; sleep(2) }
  func testTap() { let a = safari(); let w = a.windows.firstMatch
    w.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: env("X"), dy: env("Y"))).tap() }
  func testDrag() { let a = safari(); let w = a.windows.firstMatch
    let o = w.coordinate(withNormalizedOffset: .zero)
    o.withOffset(CGVector(dx: env("X1"), dy: env("Y1"))).press(forDuration: 0.05, thenDragTo: o.withOffset(CGVector(dx: env("X2"), dy: env("Y2")))) }
  // Two real fingers, centred on an element: the page's web view by default, or the first element whose label contains LABEL.
  func testPinch() { let a = safari()
    let label = ProcessInfo.processInfo.environment["LABEL"] ?? ""
    let e = label.isEmpty ? a.webViews.firstMatch : a.webViews.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", label)).firstMatch
    e.pinch(withScale: CGFloat(env("SCALE")), velocity: CGFloat(env("VELOCITY"))) }
}
