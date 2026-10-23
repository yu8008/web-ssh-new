from app.services.terminal_modes import TerminalModes


def test_paste_mode_survives_every_control_sequence_boundary():
    for control in ("\x1b[?2004h", "\x9b?2004h", "\x1b[?25;02004;1000h"):
        for split in range(len(control) + 1):
            modes = TerminalModes()
            modes.feed(control[:split])
            modes.feed(control[split:])
            assert modes.bracketed_paste
            modes.feed("\x1b[?2004l")
            assert not modes.bracketed_paste


def test_embedded_controls_in_strings_do_not_change_paste_mode():
    strings = ["\x1b]0;title\x1b[?2004l\x07", "\x1bPtmux;\x1b\x1b[?2004l\x1b\\",
               "\x1b_Gimage\x1b[?2004l\x1b\\", "\x9d0;title\x9b?2004l\x9c"]
    for string in strings:
        for split in range(len(string) + 1):
            modes = TerminalModes()
            modes.feed("\x1b[?2004h" + string[:split])
            modes.feed(string[split:])
            assert modes.bracketed_paste
            modes.feed("\x1b[?2004l")
            assert not modes.bracketed_paste


def test_reset_cancellation_invalid_and_oversized_controls():
    modes = TerminalModes()
    modes.feed("\x1b[?2004h\x1bc")
    assert not modes.bracketed_paste
    for value in ["2004h", "\x1b[2004h", "\x1b[?2004p", "\x1b[?2004\x18h", "\x1b[?2004\x1ah",
                  "\x1b[?" + "0;" * 1000 + "2004h"]:
        modes.feed(value)
        assert not modes.bracketed_paste
        assert len(modes._pending) <= 128
    modes.feed("\x1b[unfinished\x1b[?2004h")
    assert modes.bracketed_paste
