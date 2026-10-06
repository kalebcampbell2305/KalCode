import AVFoundation
import SwiftUI
import UIKit
import RemoteKit

/// Full-screen QR scanner with a framing reticle. Falls back gracefully when the camera is
/// unavailable (simulator) or denied, always offering "Paste pairing link".
struct ScannerView: View {
    var onLink: (String) -> Void
    var onPaste: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    enum CameraState: Equatable { case checking, ready, denied, unavailable }
    @State private var camera: CameraState = .checking
    @State private var torch = false
    @State private var error: String?
    @State private var lastRejected: String?

    var body: some View {
        ZStack {
            Palette.sunken.ignoresSafeArea()
            switch camera {
            case .ready:
                QRCameraView(torch: torch, onCode: handle)
                    .ignoresSafeArea()
                Reticle()
            case .checking:
                ProgressView().tint(Palette.accentText)
            case .denied:
                fallback(symbol: "camera.fill", title: "Camera access is off",
                         message: "Allow the camera in Settings to scan the pairing code, or paste the link instead.",
                         settings: true)
            case .unavailable:
                fallback(symbol: "camera.metering.unknown", title: "No camera available",
                         message: "This device can't scan codes. Copy the pairing link on your workstation and paste it here.",
                         settings: false)
            }

            VStack {
                HStack {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .buttonStyle(IconCircleButtonStyle(size: 40, tint: Palette.text))
                        .accessibilityLabel("Close")
                        .accessibilityIdentifier("scanner.close")
                    Spacer()
                    if camera == .ready, AVCaptureDevice.default(for: .video)?.hasTorch == true {
                        Button { torch.toggle(); Haptics.select() } label: {
                            Image(systemName: torch ? "flashlight.on.fill" : "flashlight.off.fill")
                        }
                        .buttonStyle(IconCircleButtonStyle(size: 40, tint: torch ? Palette.amber : Palette.text))
                        .accessibilityLabel(torch ? "Turn torch off" : "Turn torch on")
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                Spacer()
                if camera == .ready {
                    VStack(spacing: 14) {
                        if let error {
                            Text(error)
                                .font(.kcFootnote)
                                .foregroundStyle(Palette.redText)
                                .multilineTextAlignment(.center)
                                .padding(.horizontal, 14).padding(.vertical, 10)
                                .background(Capsule().fill(Palette.surface3.opacity(0.9)))
                                .accessibilityIdentifier("scanner.error")
                        } else {
                            Text("Point at the code on your workstation")
                                .font(.kcSubMedium)
                                .foregroundStyle(Palette.text)
                                .padding(.horizontal, 14).padding(.vertical, 10)
                                .background(Capsule().fill(.black.opacity(0.55)))
                        }
                        Button(action: onPaste) { Label("Paste pairing link", systemImage: "link") }
                            .buttonStyle(SecondaryButtonStyle(fullWidth: false))
                            .accessibilityIdentifier("scanner.paste")
                    }
                    .padding(.bottom, 32)
                }
            }
        }
        .preferredColorScheme(.dark)
        .task { await checkCamera() }
        .onDisappear { torch = false }
    }

    private func fallback(symbol: String, title: String, message: String, settings: Bool) -> some View {
        VStack(spacing: 18) {
            EmptyStateView(symbol: symbol, title: title, message: message)
            VStack(spacing: 10) {
                Button(action: onPaste) { Label("Paste pairing link", systemImage: "link") }
                    .buttonStyle(PrimaryButtonStyle())
                    .accessibilityIdentifier("scanner.paste")
                if settings {
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    }
                    .buttonStyle(SecondaryButtonStyle())
                }
            }
            .frame(maxWidth: 380)
            .padding(.horizontal, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Atmosphere(level: .standard, nebulaHeight: 360))
    }

    private func checkCamera() async {
        guard AVCaptureDevice.default(for: .video) != nil else { camera = .unavailable; return }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: camera = .ready
        case .notDetermined:
            camera = await AVCaptureDevice.requestAccess(for: .video) ? .ready : .denied
        default: camera = .denied
        }
    }

    private func handle(_ code: String) {
        guard code != lastRejected else { return }
        do {
            _ = try PairingLink.parse(code)
            Haptics.success()
            onLink(code)
        } catch let e as PairingLinkError {
            lastRejected = code
            Haptics.error()
            withAnimation(Motion.quick) { error = ErrorCopy.link(e) }
        } catch {}
    }
}

/// Corner-bracket framing reticle with a soft blue glow.
private struct Reticle: View {
    var body: some View {
        GeometryReader { geo in
            let side = min(geo.size.width, geo.size.height) * 0.66
            let rect = CGRect(x: (geo.size.width - side) / 2, y: (geo.size.height - side) / 2 - 30, width: side, height: side)
            ZStack {
                // Dim everything outside the frame.
                Path { p in
                    p.addRect(CGRect(origin: .zero, size: geo.size))
                    p.addRoundedRect(in: rect, cornerSize: CGSize(width: 24, height: 24), style: .continuous)
                }
                .fill(Color.black.opacity(0.55), style: FillStyle(eoFill: true))

                Path { p in
                    let l: CGFloat = 34
                    let r: CGFloat = 24
                    // top-left
                    p.move(to: CGPoint(x: rect.minX, y: rect.minY + l))
                    p.addLine(to: CGPoint(x: rect.minX, y: rect.minY + r))
                    p.addQuadCurve(to: CGPoint(x: rect.minX + r, y: rect.minY), control: CGPoint(x: rect.minX, y: rect.minY))
                    p.addLine(to: CGPoint(x: rect.minX + l, y: rect.minY))
                    // top-right
                    p.move(to: CGPoint(x: rect.maxX - l, y: rect.minY))
                    p.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
                    p.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY + r), control: CGPoint(x: rect.maxX, y: rect.minY))
                    p.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + l))
                    // bottom-right
                    p.move(to: CGPoint(x: rect.maxX, y: rect.maxY - l))
                    p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
                    p.addQuadCurve(to: CGPoint(x: rect.maxX - r, y: rect.maxY), control: CGPoint(x: rect.maxX, y: rect.maxY))
                    p.addLine(to: CGPoint(x: rect.maxX - l, y: rect.maxY))
                    // bottom-left
                    p.move(to: CGPoint(x: rect.minX + l, y: rect.maxY))
                    p.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
                    p.addQuadCurve(to: CGPoint(x: rect.minX, y: rect.maxY - r), control: CGPoint(x: rect.minX, y: rect.maxY))
                    p.addLine(to: CGPoint(x: rect.minX, y: rect.maxY - l))
                }
                .stroke(Palette.accent, style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
                .shadow(color: Palette.accent.opacity(0.8), radius: 8)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// AVCaptureSession + AVCaptureMetadataOutput(.qr).
private struct QRCameraView: UIViewRepresentable {
    var torch: Bool
    var onCode: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.videoGravity = .resizeAspectFill
        context.coordinator.configure(view)
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {
        context.coordinator.onCode = onCode
        context.coordinator.setTorch(torch)
    }

    static func dismantleUIView(_ uiView: PreviewView, coordinator: Coordinator) {
        coordinator.stop()
    }

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: (String) -> Void
        private let session = AVCaptureSession()
        private let queue = DispatchQueue(label: "com.kalcode.remote.scanner")
        private var device: AVCaptureDevice?
        private var lastCode: String?

        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func configure(_ view: PreviewView) {
            view.previewLayer.session = session
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input) else { return }
            self.device = device
            session.beginConfiguration()
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            if session.canAddOutput(output) {
                session.addOutput(output)
                output.setMetadataObjectsDelegate(self, queue: .main)
                if output.availableMetadataObjectTypes.contains(.qr) { output.metadataObjectTypes = [.qr] }
            }
            session.commitConfiguration()
            let session = self.session
            queue.async { session.startRunning() }
        }

        func stop() {
            setTorch(false)
            let session = self.session
            queue.async { if session.isRunning { session.stopRunning() } }
        }

        func setTorch(_ on: Bool) {
            guard let device, device.hasTorch, (device.torchMode == .on) != on else { return }
            try? device.lockForConfiguration()
            device.torchMode = on ? .on : .off
            device.unlockForConfiguration()
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard let code = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue, code != lastCode else { return }
            lastCode = code
            onCode(code)
        }
    }
}
