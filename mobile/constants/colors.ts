const palette = {
  orange: '#FF6B35',
  orangeLight: '#FF8C42',
  black: '#0D0D0D',
  card: '#1A1A1A',
  cardAlt: '#222222',
  border: '#2A2A2A',
  white: '#FFFFFF',
  muted: '#888888',
  mutedDark: '#555555',
  success: '#22C55E',
  danger: '#EF4444',
  warning: '#F59E0B',
  info: '#3B82F6',
};

export const colors = {
  primary: palette.orange,
  accent: palette.orangeLight,
  background: palette.black,
  card: palette.card,
  cardAlt: palette.cardAlt,
  border: palette.border,
  foreground: palette.white,
  muted: palette.muted,
  mutedDark: palette.mutedDark,
  success: palette.success,
  danger: palette.danger,
  warning: palette.warning,
  info: palette.info,
  tabBar: '#111111',
  inputBg: '#1E1E1E',
  radius: 12,
  radiusSm: 8,
  radiusLg: 20,
  radiusFull: 999,
};

export type Colors = typeof colors;
