/* 《光阴的歌》（东山少爷）歌词数据，供 ParticleEffe 页面使用。
 * 纯数据 + 展平，与渲染/动画逻辑无关。 */

const STANZAS = {
  a: [
    '东山的蜗居换成合心新居',
    '竟已丢失情趣',
    '人大了后总左右失据',
    '明明很讨厌雪茄却袋一堆',
  ],
  b: [
    '西关的小姐后来随哪个姓',
    '可有抹掉了率性',
    '和昨天亲昵姊妹疏远末倾听',
    '从今只重聚于婚庆',
  ],
  c: [
    '全心唱歌 你有否爱过我的歌',
    '陪伴你青春光景闯祸',
    '每次痛着静坐 每次笑容傻傻',
    '月光光有照地塘么',
  ],
  d: [
    '全心唱歌 你记忆里有我的么',
    '回望小北街口甜蜜如初',
    '年少过 未受饿 跌碰过 如研磨',
    '傻小子变老练的我',
  ],
  e: [
    '年华如无法逆陀螺',
    '再次奢想让我',
    '快乐如提前能下课',
    '在校道上拍拖',
    '对老去光阴唱歌',
  ],
};

// 演出顺序（副歌按原曲重复）
const ORDER = ['a', 'b', 'c', 'd', 'b', 'c', 'd', 'e', 'c', 'd'];
const FINAL_LINE = '我永远是傻傻的我';

// 展平成单行列表：{ text, gapBefore }，段落首行标记 gapBefore（留段落空隙）
const LINES = [];
for (const key of ORDER) {
  STANZAS[key].forEach((text, i) => {
    LINES.push({ text, gapBefore: i === 0 });
  });
}
LINES.push({ text: FINAL_LINE, gapBefore: true });

export default LINES;
