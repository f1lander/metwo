// Mo is the "o" of the mevo wordmark: a ring with a pupil. Local units: the ring spans
// x -150..150 and y 0..273, its hole is centred at (0, 137).
export const RING = 'M0 0 C0.4 0 0.4 0 2.42 0.01 C13.95 0.06 25.1 0.35 36.31 3.31 C37.09 3.51 37.87 3.71 38.68 3.91 C76.37 13.71 107.57 36 128.12 69.28 C145.11 98.25 150.6 132.58 143.31 165.31 C143.15 166.04 142.99 166.77 142.82 167.52 C134.67 203.03 112.72 232.99 82.09 252.45 C48.41 273.07 4.18 280.97 -34.52 271.86 C-35.23 271.68 -35.95 271.5 -36.69 271.31 C-37.09 271.21 -37.09 271.21 -39.11 270.71 C-75.62 261.29 -108.32 239.73 -128.03 207.09 C-146.52 175.32 -151.39 138.76 -142.43 103.1 C-133.39 69.75 -110.86 39.65 -81.2 21.81 C-69.84 15.31 -58.23 10.06 -45.69 6.31 C-45.04 6.12 -44.38 5.92 -43.71 5.72 C-29.16 1.4 -15.11 -0.07 0 0 Z M-62.23 89.23 C-76.56 107.39 -80.51 127.71 -78.69 150.31 C-76.81 164.96 -69.51 178.49 -59.69 189.31 C-58.99 190.09 -58.29 190.87 -57.57 191.68 C-44.38 205.65 -25.77 213.75 -6.66 214.7 C15.57 215.31 36.44 210.68 53.31 195.31 C54.07 194.64 54.83 193.96 55.61 193.26 C69.83 179.85 78.17 160.7 78.79 141.22 C78.97 120.09 72.73 101.07 58.31 85.31 C58.02 84.97 58.02 84.97 56.52 83.25 C42.88 68.42 23.42 61.6 3.75 60.03 C-21.93 59.36 -45.4 69.92 -62.23 89.23 Z'

// where the ring sits inside the mevo wordmark (viewBox 0 0 1410 387), for docking into it
export const RING_IN_LOGO = { x: 1239.6875, y: 88.6875 } as const

// the mascot's own box: room around the ring for bounces, the shadow and the overlays
export const VIEWBOX = { x: -200, y: -170, w: 400, h: 500 } as const
export const RING_CENTER = { x: 0, y: 137 } as const
export const RING_WIDTH = 300
export const PUPIL = { cx: 0, cy: 138, r: 34 } as const
// the hole of the ring, frosted so the page behind doesn't show through
export const HOLE = { cx: 0, cy: 137.5, r: 79 } as const

export const COLORS = { accent: '#7c5cff', tank: '#2a2541', amber: '#f2b84b', bad: '#f0727a', pupil: '#fff', ink: '#e6e7ea', soft: '#c4c6cc', z: '#a58fff', sweat: '#7cc4ff', shadow: '#000' }
