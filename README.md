# fonghokcung.github.io

https://fonghokcung.github.io/

## 開發注意事項

1. 流動優先（Mobile First）：
   樣式預設為流動端（<768px），桌面端用 `@media (min-width: 768px)` 覆蓋
2. 舞台浮層不進左上角：
   流動端左上角被 App 的漢堡選單按鈕佔據（fixed，12px 起 44×44），
   頁面內的角落浮層請加全域類別 `overlay-corner`（流動端右上 / 桌面左上，見 `base.css`）。

#### END
