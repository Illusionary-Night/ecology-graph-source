# 本機執行

在專案資料夾開啟終端機並執行：

```sh
python3 -m http.server 8000
```

在瀏覽器開啟 <http://localhost:8000>。若系統沒有 `python3` 指令，可使用 `python -m http.server 8000`。

網頁使用 JavaScript ES modules，請透過本機伺服器開啟，不要直接開啟 `index.html` 檔案。更多專案資訊、測試與網址參數請看 `README.md`。
