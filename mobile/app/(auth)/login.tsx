import { useState } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
import { Link, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/context/AuthContext';
import { colors } from '@/constants/colors';

export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const { login } = useAuth();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!phone.trim() || !password.trim()) {
      Alert.alert('Lỗi', 'Vui lòng nhập đầy đủ thông tin');
      return;
    }
    try {
      setLoading(true);
      await login(phone.trim(), password);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace('/(tabs)');
    } catch (e: any) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Đăng nhập thất bại', e.message || 'Sai số điện thoại hoặc mật khẩu');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[s.scroll, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={s.logo}>
          <View style={s.logoCircle}>
            <Text style={s.logoText}>SP</Text>
          </View>
          <Text style={s.brand}>SafePass</Text>
          <Text style={s.tagline}>Mua bán vé an toàn</Text>
        </View>

        <View style={s.form}>
          <Text style={s.label}>Số điện thoại</Text>
          <TextInput
            style={s.input}
            placeholder="0912345678"
            placeholderTextColor={colors.mutedDark}
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            autoComplete="tel"
          />

          <Text style={s.label}>Mật khẩu</Text>
          <TextInput
            style={s.input}
            placeholder="••••••••"
            placeholderTextColor={colors.mutedDark}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />

          <Pressable
            style={[s.btn, loading && s.btnDisabled]}
            onPress={handleLogin}
            disabled={loading}
          >
            <Text style={s.btnText}>{loading ? 'Đang đăng nhập...' : 'Đăng nhập'}</Text>
          </Pressable>

          <View style={s.footer}>
            <Text style={s.footerText}>Chưa có tài khoản? </Text>
            <Link href="/(auth)/register" asChild>
              <Pressable>
                <Text style={s.footerLink}>Đăng ký</Text>
              </Pressable>
            </Link>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  scroll: { flexGrow: 1, paddingHorizontal: 24 },
  logo: { alignItems: 'center', marginBottom: 48 },
  logoCircle: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 12,
  },
  logoText: { color: '#fff', fontSize: 24, fontFamily: 'Inter_700Bold' },
  brand: { color: colors.foreground, fontSize: 28, fontFamily: 'Inter_700Bold' },
  tagline: { color: colors.muted, fontSize: 14, fontFamily: 'Inter_400Regular', marginTop: 4 },
  form: { gap: 8 },
  label: { color: colors.muted, fontSize: 13, fontFamily: 'Inter_500Medium', marginBottom: 4 },
  input: {
    backgroundColor: colors.inputBg, borderRadius: colors.radiusSm,
    borderWidth: 1, borderColor: colors.border,
    color: colors.foreground, fontSize: 16, fontFamily: 'Inter_400Regular',
    padding: 14, marginBottom: 16,
  },
  btn: {
    backgroundColor: colors.primary, borderRadius: colors.radius,
    padding: 16, alignItems: 'center', marginTop: 8,
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#fff', fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: 24 },
  footerText: { color: colors.muted, fontFamily: 'Inter_400Regular' },
  footerLink: { color: colors.primary, fontFamily: 'Inter_600SemiBold' },
});
