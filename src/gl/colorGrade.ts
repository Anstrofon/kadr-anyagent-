// Professional Color Grading (Lumetri Color style) engine for Kadr.
// Supports White Balance (Temperature, Tint), Tone (Exposure, Contrast,
// Highlights, Shadows, Whites, Blacks), Color (Saturation, Vibrance, Hue, Gamma),
// and Vignette.

export interface ColorGradeParams {
  temperature: number // -100 .. 100 (cool -> warm)
  tint: number        // -100 .. 100 (green -> magenta)
  exposure: number    // -3.0 .. 3.0 (EV stops)
  contrast: number    // -100 .. 100
  highlights: number  // -100 .. 100
  shadows: number     // -100 .. 100
  whites: number      // -100 .. 100
  blacks: number      // -100 .. 100
  saturation: number  // 0 .. 200 (%)
  vibrance: number    // -100 .. 100
  hue: number         // -180 .. 180 (degrees)
  gamma: number       // 0.2 .. 3.0 (default 1.0)
  vignette: number    // -100 .. 100
}

export const COLOR_GRADE_DEFAULTS: ColorGradeParams = {
  temperature: 0,
  tint: 0,
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  saturation: 100,
  vibrance: 0,
  hue: 0,
  gamma: 1.0,
  vignette: 0
}

export interface ColorPreset {
  id: string
  name: string
  nameKey: string
  params: Partial<ColorGradeParams>
}

export const COLOR_LOOK_PRESETS: ColorPreset[] = [
  {
    id: 'teal-orange',
    name: 'Teal & Orange',
    nameKey: 'cgPresetTealOrange',
    params: {
      temperature: 16,
      tint: -4,
      exposure: 0.1,
      contrast: 22,
      highlights: 15,
      shadows: -18,
      whites: 8,
      blacks: -12,
      saturation: 115,
      vibrance: 25,
      hue: 0,
      gamma: 0.95,
      vignette: 20
    }
  },
  {
    id: 'warm-vintage',
    name: 'Теплий вінтаж',
    nameKey: 'cgPresetWarmVintage',
    params: {
      temperature: 32,
      tint: 12,
      exposure: 0.12,
      contrast: -10,
      highlights: -15,
      shadows: 18,
      whites: -8,
      blacks: 16,
      saturation: 85,
      vibrance: -8,
      hue: 4,
      gamma: 1.06,
      vignette: 28
    }
  },
  {
    id: 'cold-noir',
    name: 'Холодний нуар',
    nameKey: 'cgPresetColdNoir',
    params: {
      temperature: -38,
      tint: -8,
      exposure: -0.1,
      contrast: 28,
      highlights: 12,
      shadows: -26,
      whites: 10,
      blacks: -18,
      saturation: 60,
      vibrance: -15,
      hue: -4,
      gamma: 0.92,
      vignette: 35
    }
  },
  {
    id: 'cyberpunk',
    name: 'Кіберпанк',
    nameKey: 'cgPresetCyberpunk',
    params: {
      temperature: -18,
      tint: 32,
      exposure: 0.18,
      contrast: 32,
      highlights: 22,
      shadows: -12,
      whites: 16,
      blacks: -14,
      saturation: 138,
      vibrance: 40,
      hue: 12,
      gamma: 0.92,
      vignette: 30
    }
  },
  {
    id: 'bw-classic',
    name: 'Ч/Б Класика',
    nameKey: 'cgPresetBwClassic',
    params: {
      temperature: 0,
      tint: 0,
      exposure: 0.05,
      contrast: 28,
      highlights: 15,
      shadows: -15,
      whites: 12,
      blacks: -12,
      saturation: 0,
      vibrance: 0,
      hue: 0,
      gamma: 1.0,
      vignette: 18
    }
  },
  {
    id: 'faded-film',
    name: 'Плівка',
    nameKey: 'cgPresetFadedFilm',
    params: {
      temperature: 8,
      tint: 4,
      exposure: 0.0,
      contrast: -16,
      highlights: -18,
      shadows: 24,
      whites: -14,
      blacks: 26,
      saturation: 82,
      vibrance: -6,
      hue: 0,
      gamma: 1.08,
      vignette: 15
    }
  },
  {
    id: 'golden-hour',
    name: 'Золота година',
    nameKey: 'cgPresetGoldenHour',
    params: {
      temperature: 42,
      tint: 14,
      exposure: 0.12,
      contrast: 14,
      highlights: 18,
      shadows: -8,
      whites: 10,
      blacks: -6,
      saturation: 118,
      vibrance: 28,
      hue: -4,
      gamma: 0.96,
      vignette: 18
    }
  },
  {
    id: 'sunset-drama',
    name: 'Захід сонця',
    nameKey: 'cgPresetSunsetDrama',
    params: {
      temperature: 28,
      tint: 38,
      exposure: -0.15,
      contrast: 32,
      highlights: 26,
      shadows: -30,
      whites: 14,
      blacks: -20,
      saturation: 132,
      vibrance: 32,
      hue: 8,
      gamma: 0.88,
      vignette: 40
    }
  }
]
