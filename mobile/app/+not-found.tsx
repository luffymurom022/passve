import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/constants/colors';

export default function NotFoundScreen() {
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <Ionicons name="alert-circle-outline" size={56} color={colors.mutedDark} />
      <Text style={s.title}>Trang không tồn tại</Text>
      <Pressable style={s.btn} onPress={() => router.replace('/')}>
        <Text style={s.btnText}>Về trang chủ</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: colors.background,
    alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24,
  },
  title: { color: colors.foreground, fontSize: 18, fontFamily: 'Inter_600SemiBold' },
  btn: {
    backgroundColor: colors.primary, paddingHorizontal: 28, paddingVertical: 12,
    borderRadius: colors.radius,
  },
  btnText: { color: '#fff', fontFamily: 'Inter_600SemiBold', fontSize: 15 },
});
