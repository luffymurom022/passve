import {
  View, Text, FlatList, TextInput, Pressable, StyleSheet,
  ActivityIndicator, Platform, KeyboardAvoidingView, Image,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useState, useRef } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { apiFetch, apiRequest, queryClient } from '@/lib/query-client';
import { useAuth } from '@/context/AuthContext';
import { colors } from '@/constants/colors';

interface Message {
  id: number;
  sender_id: number;
  content: string;
  created_at: string;
  sender_name?: string;
}

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [text, setText] = useState('');
  const flatRef = useRef<FlatList>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['/api/dm/conversations', id, 'messages'],
    queryFn: () => apiFetch<{ messages: Message[] } | Message[]>(`/api/dm/conversations/${id}/messages`),
    refetchInterval: 5_000,
  });

  const messages: Message[] = (Array.isArray(data) ? data : (data as any)?.messages ?? []).slice().reverse();

  const convQuery = useQuery({
    queryKey: ['/api/dm/conversations', id],
    queryFn: () => apiFetch<any>(`/api/dm/conversations`),
    select: (d: any) => {
      const list = Array.isArray(d) ? d : d?.conversations ?? [];
      return list.find((c: any) => String(c.id) === String(id));
    },
  });

  const sendMutation = useMutation({
    mutationFn: (content: string) =>
      apiRequest(`/api/dm/conversations/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/dm/conversations', id, 'messages'] });
      queryClient.invalidateQueries({ queryKey: ['/api/dm/conversations'] });
    },
  });

  const handleSend = async () => {
    const msg = text.trim();
    if (!msg || sendMutation.isPending) return;
    setText('');
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await sendMutation.mutateAsync(msg);
  };

  const otherName = convQuery.data?.other_user_name ?? 'Trò chuyện';

  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const bottomPad = Platform.OS === 'web' ? 34 : insets.bottom;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={[s.header, { paddingTop: topPad + 8 }]}>
        <Pressable style={s.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={colors.foreground} />
        </Pressable>
        <View style={s.headerAvatarWrap}>
          <View style={s.headerAvatar}>
            <Text style={s.headerAvatarText}>{otherName?.[0]?.toUpperCase() ?? '?'}</Text>
          </View>
        </View>
        <Text style={s.headerName}>{otherName}</Text>
      </View>

      {isLoading ? (
        <View style={s.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <FlatList
          ref={flatRef}
          data={messages}
          inverted
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={s.list}
          showsVerticalScrollIndicator={false}
          scrollEnabled={!!messages.length}
          renderItem={({ item }) => {
            const isMe = item.sender_id === user?.id;
            return (
              <View style={[s.bubble, isMe ? s.bubbleMe : s.bubbleThem]}>
                <Text style={[s.bubbleText, isMe ? s.bubbleTextMe : s.bubbleTextThem]}>
                  {item.content}
                </Text>
                <Text style={[s.bubbleTime, isMe ? s.bubbleTimeMe : s.bubbleTimeThem]}>
                  {new Date(item.created_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                </Text>
              </View>
            );
          }}
          ListEmptyComponent={
            <View style={s.center}>
              <Text style={{ color: colors.muted, fontFamily: 'Inter_400Regular' }}>Bắt đầu cuộc trò chuyện</Text>
            </View>
          }
        />
      )}

      <View style={[s.inputBar, { paddingBottom: bottomPad + 8 }]}>
        <TextInput
          style={s.input}
          placeholder="Nhập tin nhắn..."
          placeholderTextColor={colors.mutedDark}
          value={text}
          onChangeText={setText}
          multiline
          maxLength={500}
          returnKeyType="send"
          onSubmitEditing={handleSend}
        />
        <Pressable
          style={[s.sendBtn, (!text.trim() || sendMutation.isPending) && s.sendBtnDisabled]}
          onPress={handleSend}
          disabled={!text.trim() || sendMutation.isPending}
        >
          <Ionicons name="send" size={20} color="#fff" />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: colors.border,
    backgroundColor: colors.background,
  },
  backBtn: { padding: 4 },
  headerAvatarWrap: {},
  headerAvatar: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: colors.primary + '33',
    alignItems: 'center', justifyContent: 'center',
  },
  headerAvatarText: { color: colors.primary, fontFamily: 'Inter_700Bold', fontSize: 15 },
  headerName: { color: colors.foreground, fontSize: 16, fontFamily: 'Inter_600SemiBold', flex: 1 },
  list: { padding: 16, gap: 8, flexGrow: 1 },
  bubble: { maxWidth: '80%', marginBottom: 8 },
  bubbleMe: { alignSelf: 'flex-end' },
  bubbleThem: { alignSelf: 'flex-start' },
  bubbleText: { fontSize: 15, fontFamily: 'Inter_400Regular', lineHeight: 22 },
  bubbleTextMe: {
    backgroundColor: colors.primary, color: '#fff',
    borderRadius: 18, borderBottomRightRadius: 4,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  bubbleTextThem: {
    backgroundColor: colors.card, color: colors.foreground,
    borderRadius: 18, borderBottomLeftRadius: 4,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  bubbleTime: { fontSize: 10, fontFamily: 'Inter_400Regular', marginTop: 3 },
  bubbleTimeMe: { color: colors.mutedDark, textAlign: 'right' },
  bubbleTimeThem: { color: colors.mutedDark, textAlign: 'left' },
  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 10,
    paddingHorizontal: 16, paddingTop: 10,
    borderTopWidth: 1, borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  input: {
    flex: 1, backgroundColor: colors.inputBg,
    borderRadius: 20, borderWidth: 1, borderColor: colors.border,
    color: colors.foreground, fontFamily: 'Inter_400Regular', fontSize: 15,
    paddingHorizontal: 16, paddingVertical: 10, maxHeight: 120,
  },
  sendBtn: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  sendBtnDisabled: { opacity: 0.4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
