  <script>
  // Маленький помощник: безопасный генератор UCID (UUID без дефисов)
  function genUcid() {
    if (crypto && crypto.randomUUID) {
      return crypto.randomUUID().replace(/-/g, '');
    }
    // Фолбэк-генератор (простой, не крипто)
    return 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/x/g, () =>
      Math.floor(Math.random() * 16).toString(16)
    );
  }

  // Опционально: нарезка длинного текста на куски (Яндекс любит короткие блоки)
  function chunkText(str, maxLen = 4000) {
    const chunks = [];
    let i = 0;
    while (i < str.length) {
      chunks.push(str.slice(i, i + maxLen));
      i += maxLen;
    }
    return chunks;
  }

  // Основная функция перевода
  async function yandexTranslate(text, lang = 'en-ru') {
  const ucid = crypto.randomUUID().replace(/-/g, '');
  const url = `https://translate.yandex.net/api/v1/tr.json/translate?ucid=${ucid}&srv=android&format=text`;

  const params = new URLSearchParams();
  params.append('text', text);
  params.append('lang', lang);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  return data.text.join('');
}


  // Пример использования:
   // yandexTranslate('Привет, мир!', 'en').then(console.log).catch(console.error);
</script>
