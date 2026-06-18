import SwiftUI

@main
struct StatusHubApp: App {
    @StateObject private var model = HubModel()
    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
            #if os(macOS)
                .frame(minWidth: 420, idealWidth: 460, minHeight: 640, idealHeight: 820)
            #endif
        }
        #if os(macOS)
        .windowResizability(.contentSize)
        #endif
    }
}

struct RootView: View {
    @EnvironmentObject var model: HubModel
    var body: some View {
        Group {
            if model.authed {
                DashboardView()
            } else {
                LoginView()
            }
        }
        .onAppear { model.start() }
    }
}

struct LoginView: View {
    @EnvironmentObject var model: HubModel
    @State private var pw = ""
    @State private var busy = false
    @State private var err: String?
    var body: some View {
        ZStack {
            Color.bg.ignoresSafeArea()
            VStack(spacing: 16) {
                Text("Status Hub").font(.largeTitle.bold())
                secureField
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .frame(maxWidth: 280)
                if let err { Text(err).foregroundColor(.red).font(.footnote) }
                Button(busy ? "…" : "Enter") {
                    busy = true; err = nil
                    Task {
                        let ok = await model.login(pw)
                        busy = false
                        if !ok { err = "Wrong password or offline" }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(pw.isEmpty || busy)
            }
            .padding()
        }
    }
    // SecureField with iOS-only autocapitalization disabled, guarded for macOS.
    private var secureField: some View {
        let field = SecureField("Password", text: $pw)
        #if os(iOS)
        return field.textInputAutocapitalization(.never)
        #else
        return field
        #endif
    }
}

struct DashboardView: View {
    @EnvironmentObject var model: HubModel
    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if let s = model.status {
                    LitterCard(litter: s.litter)
                    NutritionCard(nutrition: s.nutrition)
                    MaintenanceCard(m: s.maintenance)
                    WorkoutsCard(days: s.workouts ?? [])
                } else {
                    ProgressView().tint(.muted).padding(.top, 100)
                }
                HStack(spacing: 6) {
                    Circle().fill(model.connected ? Color(hex: 0x22c55e) : .muted).frame(width: 7, height: 7)
                    Text(model.connected ? "live" : "reconnecting…").font(.caption2).foregroundColor(.muted)
                    Spacer()
                    Button("Sign out") { model.logout() }.font(.caption2).foregroundColor(.muted)
                }
                .padding(.top, 4)
            }
            .padding()
        }
        .background(Color.bg.ignoresSafeArea())
        .refreshable { await model.fetchOnce() }
    }
}
