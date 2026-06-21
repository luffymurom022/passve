import {
  View, Text, FlatList, Pressable, StyleSheet,
  Dimensions, ActivityIndicator, Platform, Image,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useState, useRef, useCallback } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { apiFetch, apiRequest } from '@/lib/query-client';
import { queryClient } from '@/lib/query-client';
import { colors } from '@/constants/colors';

const { height: SCREEN_H, width: SCREEN_W } = Dimensions.get('window');

interface Reel {
  id: number;
  user_id: number;
  author_name: string;
  author_avatar?: string;
  caption?: string;
  video_url?: string;
  thumbnail_url?: string;
  like_count: number;
  comment_count: number;
  view_count: number;
  liked?: boolean;
}

function ReelItem({ item, isActive }: { item: Reel; isActive: boolean }) {
  const [liked, setLiked] = useState(item.liked ?? false);
  const [likeCount, setLikeCount] = useState(item.like_count ?? 0);

  const handleLike = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setLiked((prev) => !prev);
    setLikeCount((prev) => liked ? prev - 1 : prev + 1);
    try {
      await apiRequest(`/api/social/reels/${item.id}/like`, { method: 'POST' });
    } catch {}
  };

  return (
    <View style={[s.reel, { height: SCREEN_H }]}>
      {item.thumbnail_url ? (
        <Image source={{ uri: item.thumbnail_url }} style={s.bg} />
      ) : (
        <View style={[s.bg, s.bgPlaceholder]}>
          <Ionicons name="videocam-outline" size={48} color={colors.mutedDark} />
        </View>
      )}
      <View style={s.overlay} />

      <View style={s.sidebar}>
        <Pressable style={s.sideBtn} onPress={handleLike}>
          <Ionicons name={liked ? 'heart' : 'heart-outline'} size={28} color={liked ? colors.danger : '#fff'} />
          <Text style={s.sideCount}>{likeCount > 999 ? `${(likeCount / 1000).toFixed(1)}k` : likeCount}</Text>
        </Pressable>
        <Pressable style={s.sideBtn}>
          <Ionicons name="chatbubble-outline" size={26} color="#fff" />
          <Text style={s.sideCount}>{item.comment_count ?? 0}</Text>
        </Pressable>
        <Pressable style={s.sideBtn}>
          <Ionicons name="paper-plane-outline" size={26} color="#fff" />
        </Pressable>
        <Pressable style={s.sideBtn}>
          <Ionicons name="ellipsis-horizontal" size={26} color="#fff" />
        </Pressable>
      </View>

      <View style={s.bottom}>
        <View style={s.authorRow}>
          <View style={s.avatar}>
            {item.author_avatar ? (
              <Image source={{ uri: item.author_avatar }} style={s.avatarImg} />
            ) : (
              <Ionicons name="person" size={18} color="#fff" />
            )}
          </View>
          <Text style={s.authorName}>{item.author_name}</Text>
          <Pressable style={s.followBtn}>
            <Text style={s.followText}>Follow</Text>
          </Pressable>
        </View>
        {item.caption ? (
          <Text style={s.caption} numberOfLines={3}>{item.caption}</Text>
        ) : null}
        <View style={s.viewRow}>
          <Ionicons name="eye-outline" size={14} color="rgba(255,255,255,0.7)" />
          <Text style={s.viewCount}>{item.view_count ?? 0} lượt xem</Text>
        </View>
      </View>
    </View>
  );
}

export default function ReelsScreen() {
  const insets = useSafeAreaInsets();
  const [activeIndex, setActiveIndex] = useState(0);
  const viewabilityConfig = useRef({ viewAreaCoveragePercentThreshold: 60 });

  const onViewableItemsChanged = useCallback(({ viewableItems }: any) => {
    if (viewableItems.length > 0) {
      setActiveIndex(viewableItems[0].index ?? 0);
    }
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ['/api/social/reels'],
    queryFn: () => apiFetch<{ reels: Reel[] } | Reel[]>('/api/social/reels?limit=20'),
  });

  const reels = Array.isArray(data) ? data : (data as any)?.reels ?? [];

  if (isLoading) {
    return (
      <View style={[s.center, { backgroundColor: '#000' }]}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (reels.length === 0) {
    return (
      <View style={[s.center, { backgroundColor: '#000', paddingTop: insets.top }]}>
        <Ionicons name="videocam-outline" size={48} color={colors.mutedDark} />
        <Text style={{ color: colors.muted, marginTop: 12, fontFamily: 'Inter_500Medium' }}>Chưa có reels nào</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <FlatList
        data={reels}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item, index }) => <ReelItem item={item} isActive={index === activeIndex} />}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        snapToInterval={SCREEN_H}
        decelerationRate="fast"
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig.current}
        scrollEnabled={!!reels.length}
        getItemLayout={(_, index) => ({ length: SCREEN_H, offset: SCREEN_H * index, index })}
      />
    </View>
  );
}

const s = StyleSheet.create({
  reel: { width: SCREEN_W, position: 'relative', backgroundColor: '#000' },
  bg: { position: 'absolute', width: '100%', height: '100%', resizeMode: 'cover' },
  bgPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#111' },
  overlay: { position: 'absolute', width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.3)' },
  sidebar: {
    position: 'absolute', right: 16, bottom: 100,
    alignItems: 'center', gap: 20,
  },
  sideBtn: { alignItems: 'center', gap: 4 },
  sideCount: { color: '#fff', fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  bottom: { position: 'absolute', left: 16, right: 80, bottom: 80, gap: 10 },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: colors.card, borderWidth: 2, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  avatarImg: { width: 36, height: 36 },
  authorName: { color: '#fff', fontFamily: 'Inter_600SemiBold', fontSize: 14, flex: 1 },
  followBtn: {
    borderWidth: 1, borderColor: '#fff', borderRadius: 6,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  followText: { color: '#fff', fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  caption: { color: 'rgba(255,255,255,0.9)', fontSize: 14, fontFamily: 'Inter_400Regular', lineHeight: 20 },
  viewRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  viewCount: { color: 'rgba(255,255,255,0.7)', fontSize: 12, fontFamily: 'Inter_400Regular' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
});
