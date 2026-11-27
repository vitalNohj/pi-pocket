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

    func bind(key: UInt32 = UInt32(kVK_ANSI_P), modifiers: UInt32 = UInt32(cmdKey | shiftKey)) -> Bool {
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
