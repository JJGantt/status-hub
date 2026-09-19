#!/usr/bin/env python3
"""Generates the alarm tones in public/ (alarm-<slug>.m4a).

Why a generator and not six committed recordings: every tone here has to LOOP seamlessly, sit in a
band that carries through a phone speaker across a room, and be changeable without hunting for
whoever made the original. Editing a number here and re-running beats editing audio.

    python3 server/tools/make-alarms.py

Writes .wav, then `afconvert` to .m4a (macOS, no dependency) and deletes the .wav. Every file is an
exact number of seconds so the loop point lands on a beat, and every note is enveloped to zero at
both ends — a loop that clicks is a loop nobody can stand for ten minutes.
"""
import math, os, struct, subprocess, wave

SR = 44100
OUT = os.path.join(os.path.dirname(__file__), '..', 'public')

# Equal temperament from A4. Named so the melodies below read as music rather than as frequencies.
def note(n):
    return 440.0 * (2 ** ((n - 69) / 12.0))
A4, C5, D5, E5, F5, G5, A5, B5, C6, D6, E6, G6 = (note(x) for x in (69, 72, 74, 76, 77, 79, 81, 83, 84, 86, 88, 91))


# ---- voices ---------------------------------------------------------------------------------
# Each returns amplitude at time t (seconds since the note started), before enveloping.

def square_ish(t, f):
    """Odd harmonics. Cuts through background noise — the classic alarm timbre."""
    v = 0.0
    for h, a in ((1, 1.0), (3, 0.34), (5, 0.20), (7, 0.13)):
        v += a * math.sin(2 * math.pi * f * h * t)
    return v / 1.67

def bell(t, f):
    """Inharmonic partials over a fast-decaying fundamental — struck metal, not a beep."""
    v = math.sin(2 * math.pi * f * t)
    v += 0.6 * math.sin(2 * math.pi * f * 2.76 * t) * math.exp(-5 * t)
    v += 0.35 * math.sin(2 * math.pi * f * 5.40 * t) * math.exp(-8 * t)
    return v / 1.95

def pluck(t, f):
    """Marimba-ish: pure-ish tone, fast decay, a little second harmonic for the attack."""
    v = math.sin(2 * math.pi * f * t) + 0.45 * math.sin(2 * math.pi * f * 2 * t) * math.exp(-18 * t)
    return v / 1.45

def warm(t, f):
    """Soft, few harmonics. For the gentle ones — a tone you can wake to rather than be startled by."""
    return (math.sin(2 * math.pi * f * t) + 0.25 * math.sin(2 * math.pi * f * 2 * t)) / 1.25


# ---- envelopes ------------------------------------------------------------------------------

def perc(t, dur, decay=6.0):
    """Struck: instant attack, exponential decay. `decay` is how fast it dies."""
    if t < 0 or t > dur:
        return 0.0
    return min(1.0, t / 0.004) * math.exp(-decay * t) * min(1.0, (dur - t) / 0.01)

def block(t, dur, rise=0.008, fall=0.02):
    """Held: a flat note with edges softened just enough not to click."""
    if t < 0 or t > dur:
        return 0.0
    return min(1.0, t / rise, (dur - t) / fall)

def swell(t, dur):
    """Slow in, slow out. The gentle wake-ups."""
    if t < 0 or t > dur:
        return 0.0
    return math.sin(math.pi * t / dur) ** 1.5


# ---- the kit --------------------------------------------------------------------------------
# A tone is (start, duration, frequency, voice, envelope, gain). `length` is the loop length.

def render(length, notes, peak=0.92):
    frames = bytearray()
    n = int(SR * length)
    for i in range(n):
        t = i / SR
        s = 0.0
        for (start, dur, f, voice, env, gain) in notes:
            dt = t - start
            if 0.0 <= dt <= dur:
                s += voice(dt, f) * env(dt, dur) * gain
        # Soft clip rather than hard: a loud alarm that clips sounds broken, not louder.
        s = math.tanh(s * 1.1)
        frames += struct.pack('<h', int(max(-1.0, min(1.0, s)) * 32767 * peak))
    return bytes(frames)


def seq(pattern, start=0.0):
    """Helper: lay notes end to end from `start`. pattern = [(gap, dur, freq, voice, env, gain)]."""
    out, t = [], start
    for (gap, dur, f, voice, env, gain) in pattern:
        t += gap
        out.append((t, dur, f, voice, env, gain))
    return out


KIT = {}

# --- standard alarms -------------------------------------------------------------------------

# The one that shipped first. Two-tone, unmistakably an alarm.
KIT['classic'] = (2.0, [
    (0.00, 0.28, A5, square_ish, block, 0.85),
    (0.36, 0.28, A5, square_ish, block, 0.85),
    (0.72, 0.28, D6, square_ish, block, 0.85),
])

# Rising triplet, repeated and climbing — the shape that reads as "urgent" without being a siren.
KIT['radar'] = (3.0, seq([(0.00, 0.20, D5, square_ish, block, 0.8), (0.24, 0.20, A5, square_ish, block, 0.8),
                         (0.24, 0.30, D6, square_ish, block, 0.85)]) +
                     seq([(0.00, 0.20, D5, square_ish, block, 0.8), (0.24, 0.20, A5, square_ish, block, 0.8),
                         (0.24, 0.30, D6, square_ish, block, 0.85)], start=1.10) +
                     seq([(0.00, 0.16, D6, square_ish, block, 0.9), (0.20, 0.16, D6, square_ish, block, 0.9),
                         (0.20, 0.16, D6, square_ish, block, 0.9), (0.20, 0.34, E6, square_ish, block, 0.95)],
                         start=2.15))

# Fast staccato pulses. The most insistent one here — hard to sleep through, hard to enjoy.
KIT['pulse'] = (1.5, [(i * 0.1875, 0.09, A5 if i % 2 == 0 else C6, square_ish, block, 0.9) for i in range(8)])

# --- musical ---------------------------------------------------------------------------------

# Ascending major arpeggio, struck like a glockenspiel, then answered an octave up. Wakes you by
# getting brighter rather than louder.
KIT['sunrise'] = (4.0, seq([(0.00, 1.2, C5, bell, perc, 0.55), (0.30, 1.2, E5, bell, perc, 0.55),
                            (0.30, 1.2, G5, bell, perc, 0.55), (0.30, 1.6, C6, bell, perc, 0.6),
                            (0.60, 1.2, G5, bell, perc, 0.45), (0.30, 1.8, C6, bell, perc, 0.55)]))

# Marimba pattern in D minor that rolls over itself — a repeating figure rather than a signal.
KIT['ripple'] = (3.0, seq([(0.00, 0.5, D5, pluck, perc, 0.6), (0.1875, 0.5, F5, pluck, perc, 0.55),
                           (0.1875, 0.5, A5, pluck, perc, 0.55), (0.1875, 0.5, D6, pluck, perc, 0.6),
                           (0.1875, 0.5, A5, pluck, perc, 0.5), (0.1875, 0.5, F5, pluck, perc, 0.5),
                           (0.1875, 0.5, A5, pluck, perc, 0.5), (0.1875, 0.5, D6, pluck, perc, 0.55),
                           (0.1875, 0.5, E6, pluck, perc, 0.6), (0.1875, 0.5, D6, pluck, perc, 0.5),
                           (0.1875, 0.5, A5, pluck, perc, 0.5), (0.1875, 0.5, F5, pluck, perc, 0.5),
                           (0.1875, 0.6, D5, pluck, perc, 0.55), (0.375, 0.6, A5, pluck, perc, 0.45)]))

# Two soft swelling tones a fifth apart, overlapping. The quietest one — for a wake-up that is not
# an emergency. Deliberately gentle; it will lose to a deep sleep and that is the trade.
KIT['tide'] = (4.0, [(0.0, 2.2, C5, warm, swell, 0.5), (1.2, 2.2, G5, warm, swell, 0.45),
                     (2.4, 1.6, E5, warm, swell, 0.4)])

# Big bell, struck four times, ringing into the gap. Church-clock character.
KIT['bells'] = (4.0, [(i * 1.0, 1.4, G5 if i % 2 == 0 else D6, bell, lambda t, d: perc(t, d, 2.4), 0.7)
                      for i in range(4)])


def write(slug, length, notes):
    wav = os.path.join(OUT, f'alarm-{slug}.wav')
    m4a = os.path.join(OUT, f'alarm-{slug}.m4a')
    w = wave.open(wav, 'wb')
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(render(length, notes))
    w.close()
    subprocess.run(['afconvert', '-f', 'm4af', '-d', 'aac', '-b', '80000', wav, m4a], check=True)
    os.remove(wav)
    return os.path.getsize(m4a)


if __name__ == '__main__':
    for slug, (length, notes) in KIT.items():
        size = write(slug, length, notes)
        print(f'  alarm-{slug}.m4a  {length:.1f}s  {size:,}B')
