import {
  View, Text, StyleSheet, Pressable, ScrollView,
  Alert, ActivityIndicator, Platform, Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/context/AuthContext';
import { colors } from '@/constants/colors';

interface MenuItem {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  color?: string;
}

function MenuRow({ icon, label, onPress, color }: MenuItem) {
  return (
    <Pressable style={s.menuRow} onPress={onPress}>
      <View style={[s.menuIcon, { backgroundColor: (color ?? colors.primary) + '22' }]}>
        <Ionicons name={icon} size={20} color={color ?? colors.primary} />
      </View>
      <Text style={s.menuLabel}>{label}</Text>
      <Ionicons name="chevron-forward" size={16} color={colors.mutedDark} />
    </Pressable>
  );
}

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  if (!user) {
    return (
      <View style={[s.center, { paddingTop: topPad }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const handleLogout = () => {
    Alert.alert('Đăng xuất', 'Bạn có chắc muốn đăng xuất?', [
      { text: 'Huỷ', style: 'cancel' },
      {
        text: 'Đăng xuất', style: 'destructive',
        onPress: async () => {
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          await logout();
        },
      },
    ]);
  };

  const initials = user.name
    .split(' ')
    .map((w) => w[0])
    .slice(-2)
    .join('')
    .toUpperCase();

  const walletFmt = user.wallet_balance != null
    ? user.wallet_balance.toLocaleString('vi-VN') + '₫'
    : '—';

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={[s.scroll, { paddingTop: topPad, paddingBottom: insets.bottom + 24 }]}
      showsVerticalScrollIndicator={false}
    >
      <View style={s.hero}>
        <View style={s.avatarWrap}>
          {user.avatar_url ? (
            <Image source={{ uri: user.avatar_url }} style={s.avatar} />
          ) : (
            <View style={s.avatarFallback}>
              <Text style={s.avatarText}>{initials}</Text>
            </View>
          )}
          {user.is_verified && (
            <View style={s.verifiedBadge}>
              <Ionicons name="shield-checkmark" size={14} color="#fff" />
            </View>
          )}
        </View>
        <Text style={s.name}>{user.name}</Text>
        <Text style={s.phone}>{user.phone}</Text>

        <View style={s.statsRow}>
          <View style={s.stat}>
            <Text style={s.statVal}>{user.trust_score ?? 0}</Text>
            <Text style={s.statLabel}>Trust</Text>
          </View>
          <View style={s.statDivider} />
          <View style={s.stat}>
            <Text style={s.statVal}>{walletFmt}</Text>
            <Text style={s.statLabel}>Ví</Text>
          </View>
          <View style={s.statDivider} />
          <View style={s.stat}>
            <Text style={s.statVal}>{user.is_seller ? 'Người bán' : 'Người mua'}</Text>
            <Text style={s.statLabel}>Vai trò</Text>
          </View>
        </View>
      </View>

      <View style={s.section}>
        <Text style={s.sectionTitle}>Tài khoản</Text>
        <View style={s.card}>
          <MenuRow icon="person-outline" label="Thông tin cá nhân" onPress={() => {}} />
          <View style={s.sep} />
          <MenuRow icon="wallet-outline" label="Ví SafePass" onPress={() => {}} color={colors.success} />
          <View style={s.sep} />
          <MenuRow icon="receipt-outline" label="Đơn hàng của tôi" onPress={() => {}} color={colors.info} />
          <View style={s.sep} />
          <MenuRow icon="ticket-outline" label="Vé của tôi" onPress={() => {}} color={colors.warning} />
        </View>
      </View>

      <View style={s.section}>
        <Text style={s.sectionTitle}>Bảo mật</Text>
        <View style={s.card}>
          <MenuRow icon="shield-outline" label="Bảo mật tài khoản" onPress={() => {}} color={colors.primary} />
          <View style={s.sep} />
          <MenuRow icon="key-outline" label="Đổi mật khẩu" onPress={() => {}} color={colors.muted} />
        </View>
      </View>

      <View style={s.section}>
        <Text style={s.sectionTitle}>Khác</Text>
        <View style={s.card}>
          <MenuRow icon="help-circle-outline" label="Hỗ trợ" onPress={() => {}} color={colors.info} />
          <View style={s.sep} />
          <MenuRow
            icon="log-out-outline"
            label="Đăng xuất"
            onPress={handleLogout}
            color={colors.danger}
          />
        </View>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  scroll: { paddingHorizontal: 20 },
  hero: { alignItems: 'center', paddingVertical: 28 },
  avatarWrap: { position: 'relative', marginBottom: 14 },
  avatar: { width: 84, height: 84, borderRadius: 42 },
  avatarFallback: {
    width: 84, height: 84, borderRadius: 42,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontSize: 28, fontFamily: 'Inter_700Bold' },
  verifiedBadge: {
    position: 'absolute', bottom: 0, right: 0,
    backgroundColor: colors.success, borderRadius: 12,
    width: 24, height: 24, alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: colors.background,
  },
  name: { color: colors.foreground, fontSize: 22, fontFamily: 'Inter_700Bold', marginBottom: 4 },
  phone: { color: colors.muted, fontSize: 14, fontFamily: 'Inter_400Regular', marginBottom: 20 },
  statsRow: {
    flexDirection: 'row', backgroundColor: colors.card,
    borderRadius: colors.radius, padding: 16, gap: 0,
    borderWidth: 1, borderColor: colors.border, width: '100%',
  },
  stat: { flex: 1, alignItems: 'center', gap: 4 },
  statVal: { color: colors.foreground, fontSize: 14, fontFamily: 'Inter_700Bold' },
  statLabel: { color: colors.muted, fontSize: 11, fontFamily: 'Inter_400Regular' },
  statDivider: { width: 1, backgroundColor: colors.border },
  section: { marginBottom: 24 },
  sectionTitle: { color: colors.muted, fontSize: 12, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.8, marginBottom: 10, textTransform: 'uppercase' },
  card: {
    backgroundColor: colors.card, borderRadius: colors.radius,
    borderWidth: 1, borderColor: colors.border,
  },
  menuRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 16, paddingVertical: 14,
  },
  menuIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  menuLabel: { flex: 1, color: colors.foreground, fontSize: 15, fontFamily: 'Inter_500Medium' },
  sep: { height: 1, backgroundColor: colors.border, marginLeft: 66 },
  center: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
});
