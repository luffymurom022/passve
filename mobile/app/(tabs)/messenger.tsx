import {
  View, Text, FlatList, Pressable, StyleSheet,
  RefreshControl, ActivityIndicator, Image, Platform,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { apiFetch } from '@/lib/query-client';
import { colors } from '@/constants/colors';

interface Conversation {
  id: number;
  other_user_name: string;
  other_user_avatar?: string;
  last_message?: string;
  last_message_at?: string;
  unread_count?: number;
}

function ConvItem({ item }: { item: Conversation }) {
  const timeStr = item.last_message_at
    ? new Date(item.last_message_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    <Pressable
      style={s.row}
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        router.push(`/chat/${item.id}`);
      }}
    >
      <View style={s.avatarWrap}>
        {item.other_user_avatar ? (
          <Image source={{ uri: item.other_user_avatar }} style={s.avatar} />
        ) : (
          <View style={s.avatarFallback}>
            <Text style={s.avatarLetter}>{item.other_user_name?.[0]?.toUpperCase() ?? '?'}</Text>
          </View>
        )}
        {(item.unread_count ?? 0) > 0 && <View style={s.unreadDot} />}
      </View>

      <View style={s.info}>
        <View style={s.topRow}>
          <Text style={[s.name, (item.unread_count ?? 0) > 0 && s.nameUnread]}>
            {item.other_user_name}
          </Text>
          <Text style={s.time}>{timeStr}</Text>
        </View>
        <View style={s.bottomRow}>
          <Text
            style={[s.lastMsg, (item.unread_count ?? 0) > 0 && s.lastMsgUnread]}
            numberOfLines={1}
          >
            {item.last_message || 'Chưa có tin nhắn'}
          </Text>
          {(item.unread_count ?? 0) > 0 && (
            <View style={s.badge}>
              <Text style={s.badgeText}>{item.unread_count}</Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}

export default function MessengerScreen() {
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['/api/dm/conversations'],
    queryFn: () => apiFetch<{ conversations: Conversation[] } | Conversation[]>('/api/dm/conversations'),
    refetchInterval: 15_000,
  });

  const convs = Array.isArray(data) ? data : (data as any)?.conversations ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={[s.header, { paddingTop: topPad + 8 }]}>
        <Text style={s.title}>Tin nhắn</Text>
        <Pressable>
          <Ionicons name="create-outline" size={24} color={colors.foreground} />
        </Pressable>
      </View>

      {isLoading ? (
        <View style={s.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : convs.length === 0 ? (
        <View style={s.center}>
          <Ionicons name="chatbubbles-outline" size={48} color={colors.mutedDark} />
          <Text style={s.empty}>Chưa có cuộc trò chuyện nào</Text>
        </View>
      ) : (
        <FlatList
          data={convs}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => <ConvItem item={item} />}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          scrollEnabled={!!convs.length}
          ItemSeparatorComponent={() => <View style={s.sep} />}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  title: { color: colors.foreground, fontSize: 22, fontFamily: 'Inter_700Bold' },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 14, gap: 14,
  },
  avatarWrap: { position: 'relative' },
  avatar: { width: 52, height: 52, borderRadius: 26 },
  avatarFallback: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: colors.primary + '33',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarLetter: { color: colors.primary, fontSize: 20, fontFamily: 'Inter_700Bold' },
  unreadDot: {
    position: 'absolute', right: 2, top: 2,
    width: 12, height: 12, borderRadius: 6,
    backgroundColor: colors.primary, borderWidth: 2, borderColor: colors.background,
  },
  info: { flex: 1 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  name: { color: colors.foreground, fontSize: 15, fontFamily: 'Inter_500Medium' },
  nameUnread: { fontFamily: 'Inter_700Bold' },
  time: { color: colors.mutedDark, fontSize: 12, fontFamily: 'Inter_400Regular' },
  bottomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  lastMsg: { color: colors.muted, fontSize: 13, fontFamily: 'Inter_400Regular', flex: 1 },
  lastMsgUnread: { color: colors.foreground, fontFamily: 'Inter_500Medium' },
  badge: {
    backgroundColor: colors.primary, borderRadius: 10,
    minWidth: 20, height: 20, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 5,
  },
  badgeText: { color: '#fff', fontSize: 11, fontFamily: 'Inter_700Bold' },
  sep: { height: 1, backgroundColor: colors.border, marginLeft: 86 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  empty: { color: colors.muted, fontSize: 15, fontFamily: 'Inter_500Medium' },
});
