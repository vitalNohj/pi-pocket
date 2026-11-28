import Carbon

// A system registration, not an event tap or a whole-keyboard monitor.
final class WindowHotkey {
    private var handler: EventHandlerRef?
    private var binding: EventHotKeyRef?
    private var id: UInt32 = 0
    private var chord: (UInt32, UInt32)?
    private let toggle: () -> Void
    private static let signature: OSType = 0x5050574e  // PPWN

    init(toggle: @escaping () -> Void) {
        self.toggle = toggle
        var type = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
            guard let event = event, let context = context else { return OSStatus(eventNotHandledErr) }
            let hotkey = Unmanaged<WindowHotkey>.fromOpaque(context).takeUnretainedValue()
            var pressed = EventHotKeyID()
            let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                nil, MemoryLayout<EventHotKeyID>.size, nil, &pressed)
            guard status == noErr, pressed.signature == WindowHotkey.signature, pressed.id == hotkey.id else {
                return OSStatus(eventNotHandledErr)
            }
            hotkey.toggle()
            return noErr
        }, 1, &type, Unmanaged.passUnretained(self).toOpaque(), &handler)
    }

    var active: Bool { binding != nil }

    // Carbon registers physical key positions. The Settings recorder uses KeyboardEvent.code on Mac.
    func bind(_ shortcut: String) -> Bool {
        let parts = shortcut.split(separator: "+")
        guard let last = parts.last, last.count == 1,
            let offset = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789").firstIndex(of: last.first!)
        else { return false }
        let keys = [kVK_ANSI_A, kVK_ANSI_B, kVK_ANSI_C, kVK_ANSI_D, kVK_ANSI_E, kVK_ANSI_F, kVK_ANSI_G,
            kVK_ANSI_H, kVK_ANSI_I, kVK_ANSI_J, kVK_ANSI_K, kVK_ANSI_L, kVK_ANSI_M, kVK_ANSI_N, kVK_ANSI_O,
            kVK_ANSI_P, kVK_ANSI_Q, kVK_ANSI_R, kVK_ANSI_S, kVK_ANSI_T, kVK_ANSI_U, kVK_ANSI_V, kVK_ANSI_W,
            kVK_ANSI_X, kVK_ANSI_Y, kVK_ANSI_Z, kVK_ANSI_0, kVK_ANSI_1, kVK_ANSI_2, kVK_ANSI_3, kVK_ANSI_4,
            kVK_ANSI_5, kVK_ANSI_6, kVK_ANSI_7, kVK_ANSI_8, kVK_ANSI_9]
        var modifiers = 0
        for part in parts.dropLast() {
            switch part {
            case "Ctrl": modifiers |= controlKey
            case "Alt": modifiers |= optionKey
            case "Meta": modifiers |= cmdKey
            case "Shift": modifiers |= shiftKey
            default: return false
            }
        }
        return modifiers & ~shiftKey != 0 && bind(key: UInt32(keys[offset]), modifiers: UInt32(modifiers))
    }

    private func bind(key: UInt32, modifiers: UInt32) -> Bool {
        guard handler != nil else { return false }
        if let chord = chord, chord.0 == key, chord.1 == modifiers { return true }

        let next = id == 1 ? UInt32(2) : UInt32(1)
        var made: EventHotKeyRef?
        let status = RegisterEventHotKey(key, modifiers, EventHotKeyID(signature: Self.signature, id: next),
            GetApplicationEventTarget(), 0, &made)
        guard status == noErr, let made = made else { return false }

        clear()
        binding = made
        id = next
        chord = (key, modifiers)
        return true
    }

    func clear() {
        if let binding = binding { UnregisterEventHotKey(binding) }
        binding = nil
        id = 0
        chord = nil
    }

    deinit {
        clear()
        if let handler = handler { RemoveEventHandler(handler) }
    }
}
