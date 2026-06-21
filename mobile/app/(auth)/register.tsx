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

export default function RegisterScreen() {
  const insets = useSafeAreaInsets();
  const { register } = useAuth();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleRegister = async () => {
    if (!name.trim() || !phone.trim() || !password.trim()) {
      Alert.alert('Lỗi', 'Vui lòng nhập đầy đủ thông tin');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Lỗi', 'Mật khẩu tối thiểu 6 ký tự');
      return;
    }
    try {
      setLoading(true);
      await register(name.trim(), phone.trim(), password);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace('/(tabs)');
    } catch (e: any) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Đăng ký thất bại', e.message || 'Vui lòng thử lại');
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
        <View style={s.header}>
          <Text style={s.title}>Tạo tài khoản</Text>
          <Text style={s.sub}>Tham gia SafePass ngay hôm nay</Text>
        </View>

        <View style={s.form}>
          <Text style={s.label}>Họ và tên</Text>
          <TextInput
            style={s.input}
            placeholder="Nguyễn Văn A"
            placeholderTextColor={colors.mutedDark}
            value={name}
            onChangeText={setName}
            autoComplete="name"
          />

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
            placeholder="Tối thiểu 6 ký tự"
            placeholderTextColor={colors.mutedDark}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />

          <Pressable
            style={[s.btn, loading && s.btnDisabled]}
            onPress={handleRegister}
            disabled={loading}
          >
            <Text style={s.btnText}>{loading ? 'Đang tạo tài khoản...' : 'Đăng ký'}</Text>
          </Pressable>

          <View style={s.footer}>
            <Text style={s.footerText}>Đã có tài khoản? </Text>
            <Link href="/(auth)/login" asChild>
              <Pressable>
                <Text style={s.footerLink}>Đăng nhập</Text>
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
  header: { marginBottom: 40 },
  title: { color: colors.foreground, fontSize: 28, fontFamily: 'Inter_700Bold' },
  sub: { color: colors.muted, fontSize: 14, fontFamily: 'Inter_400Regular', marginTop: 6 },
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
