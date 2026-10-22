# fonghokcung.github.io

https://fonghokcung.github.io/

## 开发注意事项

1. 移动优先（Mobile First）：样式預設为移动端（<768px），桌面端用 `@media (min-width: 768px)` 覆盖
2. 舞台浮层不进左上角：移动端左上角被 App 的汉堡菜单按钮占据（fixed，12px 起 44×44），
   页面内的角落浮层请加全局类 `overlay-corner`（移动端右上 / 桌面左上，见 `base.css`），
   不要在组件里另写 `top/left/right`。若页面右上角已有面板，改用「下移到按钮下方」的局部方案

#### END
