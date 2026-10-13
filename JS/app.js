/**
 * 在线刷题 —— 核心脚本
 *
 * 职责：题库 Markdown 的解析与序列化、三个视图（首页 / 答题 / 结果）的渲染、
 *       答题交互与判分、localStorage 持久化、主题切换。
 * 题库格式规范见 md/FORMAT.md。
 *
 * 说明：页面通过 HTML 内联 onclick 调用本文件中的全局函数（如 switchView、selectMode），
 *       因此不使用模块包装，所有函数与 AppState 均保留在全局作用域。
 */

// ============ 全局状态 ============
var AppState = {
  currentBank: null, // 当前题库对象 { title, questions: [] }
  currentIndex: 0, // 当前题目下标
  userAnswers: [], // 各题用户答案；多选题为字母串（如 "AC"），多空填空题为 JSON 数组字符串
  mode: null, // 刷题模式："instant"（即时模式）| "batch"（考试模式）
  revealed: [], // 各题是否已显示答案
  currentView: "home", // 当前视图："home" | "quiz" | "result"
  filterType: "all", // 答题页的题型筛选："all" 或具体题型标识
  reviewFilter: "all", // 结果页的回顾筛选："all" | "correct" | "wrong" | "skipped"
  startTime: null, // 开始答题的时间戳
  endTime: null, // 提交/结束的时间戳
  timerInterval: null, // 计时器句柄
};

// ============ 工具函数 ============
// HTML 文本转义（覆盖 & < > " 四个字符，故同样可安全用于属性值）
function escapeHtml(s) {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
// 拼接到 HTML 属性（如 value="..."、onclick="..."）时使用；
// 转义字符集与 escapeHtml 相同，保留独立命名以标明调用场景
function escapeAttr(s) {
  return escapeHtml(s);
}
// 底部浮层提示，3 秒后自动消失
function showToast(msg) {
  var t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(function () {
    t.classList.remove("show");
  }, 3000);
}

// ============ Markdown 渲染 ============
/**
 * 轻量 Markdown 渲染（自实现，便于控制题面中的特殊语法：多空占位符、选项行等）。
 * 处理顺序：代码块 → 行内格式 → 表格 → 段落 → 还原占位符。
 * 代码块与表格先抽出为 %%CODEBLOCK_n%% / %%TABLE_n%% 占位符，
 * 避免其内部内容被后续的行内替换和分段逻辑破坏。
 */
function renderMd(text) {
  if (!text) return "";
  // 步骤 1：抽出代码块，替换为占位符
  var codeBlocks = [];
  var result = text.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    function (m, lang, code) {
      var escaped = code
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      var idx = codeBlocks.length;
      codeBlocks.push(
        '<pre><code class="language-' +
          (lang || "plaintext") +
          '">' +
          escaped +
          "</code></pre>",
      );
      return "\n%%CODEBLOCK_" + idx + "%%\n";
    },
  );
  // 步骤 2：行内格式（行内代码、粗体、斜体、无序列表）
  result = result.replace(/`([^`]+)`/g, "<code>$1</code>");
  result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // 先保护 ASCII 字母数字之间的 *（如 a*b、2*a），避免被误判为斜体标记
  result = result.replace(/([a-zA-Z0-9])\*([a-zA-Z0-9])/g, "$1%%STAR%%$2");
  result = result.replace(/\*(.+?)\*/g, "<em>$1</em>");
  result = result.replace(/%%STAR%%/g, "*");
  result = result.replace(/^- (.+)/gm, "<li>$1</li>");
  result = result.replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>");
  // 步骤 3：抽出 Markdown 表格，替换为占位符
  var tableBlocks = [];
  result = result.replace(
    /((?:^\|.+\|\n)+(?:^\|[-\s|:]+?\|\n)(?:^\|.+\|\n)*)/gm,
    function (m) {
      var rows = m.trim().split("\n");
      if (rows.length < 2) return m;
      var parseRow = function (r) {
        var parts = r.split("|");
        // 去掉首尾外框管道符产生的空单元格，保留中间的空单元格
        if (parts[0].trim() === "") parts.shift();
        if (parts.length && parts[parts.length - 1].trim() === "") parts.pop();
        return parts;
      };
      var html = '<table class="md-table"><thead><tr>';
      var headerCells = parseRow(rows[0]);
      headerCells.forEach(function (c) {
        html += "<th>" + c.trim() + "</th>";
      });
      html += "</tr></thead><tbody>";
      for (var r = 2; r < rows.length; r++) {
        html += "<tr>";
        var cells = parseRow(rows[r]);
        cells.forEach(function (c) {
          html += "<td>" + c.trim() + "</td>";
        });
        html += "</tr>";
      }
      html += "</tbody></table>";
      var idx = tableBlocks.length;
      tableBlocks.push(html);
      return "\n%%TABLE_" + idx + "%%\n";
    },
  );
  // 步骤 4：按空行分段包裹 <p>（占位符与列表块本身已是块级元素，跳过包裹）
  result = result
    .split("\n\n")
    .map(function (para) {
      var protected =
        para.indexOf("%%CODEBLOCK_") === 0 ||
        para.indexOf("%%TABLE_") === 0 ||
        para.indexOf("<ul>") === 0 ||
        para.indexOf("<li>") === 0;
      if (protected) return para;
      return "<p>" + para.replace(/\n/g, "<br>") + "</p>";
    })
    .join("\n");
  // 步骤 5：还原代码块与表格占位符（先匹配被 <p> 包裹的形式，再匹配裸占位符）
  for (var i = 0; i < codeBlocks.length; i++) {
    result = result.replace("<p>%%CODEBLOCK_" + i + "%%</p>", codeBlocks[i]);
    result = result.replace("%%CODEBLOCK_" + i + "%%", codeBlocks[i]);
  }
  for (var j = 0; j < tableBlocks.length; j++) {
    result = result.replace("<p>%%TABLE_" + j + "%%</p>", tableBlocks[j]);
    result = result.replace("%%TABLE_" + j + "%%", tableBlocks[j]);
  }
  return result;
}
// 对容器内所有代码块应用 highlight.js 高亮（hljs 由 index.html 引入）
function highlightCode(el) {
  if (typeof hljs !== "undefined") {
    el.querySelectorAll("pre code").forEach(function (b) {
      hljs.highlightElement(b);
    });
  }
}

// ============ 题型映射 ============
// 题库 Markdown 中的题型标签 → 内部类型标识（中英文标签均可，见 md/FORMAT.md）
var TYPE_MAP = {};
TYPE_MAP["单选"] = "single";
TYPE_MAP["多选"] = "multi";
TYPE_MAP["判断"] = "truefalse";
TYPE_MAP["填空"] = "fill";
TYPE_MAP["代码"] = "code";
TYPE_MAP["代码选择"] = "code";
TYPE_MAP["代码填空"] = "codefill";
TYPE_MAP["编程"] = "programming";
TYPE_MAP["single"] = "single";
TYPE_MAP["multi"] = "multi";
TYPE_MAP["truefalse"] = "truefalse";
TYPE_MAP["fill"] = "fill";
TYPE_MAP["code"] = "code";
TYPE_MAP["codechoice"] = "code";
TYPE_MAP["codefill"] = "codefill";
TYPE_MAP["programming"] = "programming";

// 内部类型标识 → 界面显示的中文题型名；用于题目标签、题型筛选与导出
var TYPE_CN = {};
TYPE_CN["single"] = "单选";
TYPE_CN["multi"] = "多选";
TYPE_CN["truefalse"] = "判断";
TYPE_CN["fill"] = "填空";
TYPE_CN["code"] = "代码选择"; // [代码] 与 [代码选择] 归为同一类型
TYPE_CN["codefill"] = "代码填空";
TYPE_CN["programming"] = "编程";

// ============ 题库解析 ============
// 解析题库 Markdown 文本，返回 { title, questions: [] }
function parseBank(mdText) {
  var bank = { title: "", questions: [] };
  var m = mdText.match(/^# (.+)$/m);
  bank.title = m ? m[1].trim() : "未命名题库";
  var lines = mdText.split("\n");
  var sections = [],
    current = [];
  // 以 `## Q数字 [...]` 为分隔，把全文切成一个个题目块
  var qHeaderRe = /^##\s+Q\d+\s*\[/;
  for (var i = 0; i < lines.length; i++) {
    if (qHeaderRe.test(lines[i].trim())) {
      if (current.length > 0) sections.push(current.join("\n"));
      current = [lines[i]];
    } else {
      current.push(lines[i]);
    }
  }
  if (current.length > 0) sections.push(current.join("\n"));
  for (var j = 0; j < sections.length; j++) {
    var q = parseQBlock(sections[j]);
    if (q) bank.questions.push(q);
  }
  return bank;
}

// 解析单个题目块，返回 { id, type, stem, choices, answer, explanation }
function parseQBlock(block) {
  var lines = block.split("\n");
  var hdrRe = /^##\s+Q(\d+)\s*\[(.+?)\]/;
  var hdr = lines[0].match(hdrRe);
  if (!hdr) return null;
  var q = {};
  q.id = hdr[1];
  q.type = TYPE_MAP[hdr[2].trim()] || hdr[2].trim();
  var content = lines.slice(1).join("\n");

  // 答案：中英文标记均可，值可跨多行（如编程题的代码块），
  // 遇到下一个 ** 标记或 --- 分隔线即结束
  var ansRe = /\*\*(?:答案|Answer)[：:]\*\*\s*\n?([\s\S]*?)(?=\n\*\*|\n---|$)/;
  var ansM = content.match(ansRe);
  q.answer = ansM ? ansM[1].trim() : "";

  // 解析：中英文标记均可，同样以 --- 分隔线为界
  var explRe =
    /\*\*(?:解析|Explanation)[：:]\*\*\s*\n?([\s\S]*?)(?:\n---|\s*$)/;
  var explM = content.match(explRe);
  q.explanation = explM ? explM[1].trim() : "";

  // 题面 = 答案标记之前的正文（不含答案与解析）
  var body = ansM ? content.substring(0, ansM.index).trim() : content.trim();
  q.choices = [];
  q.stem = "";

  if (q.type === "truefalse") {
    // 判断题：题面已显式写出 A./B. 选项时沿用，否则默认补「正确 / 错误」
    var tfRe = /^([A-Z])[.．、]\s*(.+)$/gm;
    var tfOpts = [],
      tfMatch;
    while ((tfMatch = tfRe.exec(body)) !== null) {
      tfOpts.push({ letter: tfMatch[1], text: tfMatch[2].trim() });
    }
    if (tfOpts.length >= 2) {
      var tfFirst = body.search(/^[A-Z][.．、]/m);
      q.stem = tfFirst > 0 ? body.substring(0, tfFirst).trim() : body;
      q.choices = tfOpts;
    } else {
      q.stem = body;
      q.choices = [
        { letter: "A", text: "正确" },
        { letter: "B", text: "错误" },
      ];
    }
  } else if (
    q.type === "fill" ||
    q.type === "codefill" ||
    q.type === "programming"
  ) {
    // 填空 / 代码填空 / 编程题：整段正文都是题干，无选项
    q.stem = body;
  } else {
    // 选择题：匹配 `A. 选项` / `A．选项` / `A、选项`，首个选项之前的文本即为题干
    var optRe = /^([A-Z])[.．、]\s*(.+)$/gm;
    var opts = [],
      match,
      firstIdx = -1;
    while ((match = optRe.exec(body)) !== null) {
      if (firstIdx === -1) firstIdx = match.index;
      opts.push({ letter: match[1], text: match[2].trim() });
    }
    if (opts.length > 0) {
      q.stem = body.substring(0, firstIdx).trim();
      q.choices = opts;
    } else {
      q.stem = body;
    }
  }
  return q;
}

// parseBank 的逆操作：把题库对象序列化为 Markdown 文本（用于导出，可再次导入）
function serializeBank(bank) {
  var md = "# " + bank.title + "\n\n";
  bank.questions.forEach(function (q) {
    var typeCn = TYPE_CN[q.type] || q.type;
    md += "## Q" + q.id + " [" + typeCn + "]\n" + q.stem + "\n\n";
    // 判断题的选项是解析时默认补的「正确/错误」，导出时不再写回
    if (q.choices && q.choices.length && q.type !== "truefalse") {
      q.choices.forEach(function (c) {
        md += c.letter + ". " + c.text + "\n";
      });
      md += "\n";
    }
    md += "**答案：** " + q.answer + "\n\n";
    if (q.explanation) md += "**解析：**\n" + q.explanation + "\n\n";
    md += "---\n\n";
  });
  return md;
}

// ============ 主题 ============
// 读取/写入主题偏好（localStorage 不可用时静默降级为亮色）
function getTheme() {
  try {
    return localStorage.getItem("quizTheme") || "light";
  } catch (e) {
    return "light";
  }
}
function setTheme(t) {
  try {
    localStorage.setItem("quizTheme", t);
  } catch (e) {}
}
function toggleTheme() {
  setTheme(getTheme() === "dark" ? "light" : "dark");
  applyTheme();
}
// 应用主题：切换 <html data-theme>、按钮图标，以及 highlight.js 的亮/暗样式表
function applyTheme() {
  var t = getTheme();
  document.documentElement.setAttribute("data-theme", t);
  var icon = document.getElementById("theme-icon");
  if (icon) icon.innerHTML = t === "dark" ? "☀️" : "🌙";
  var ls = document.getElementById("hljs-light-theme");
  var ds = document.getElementById("hljs-dark-theme");
  if (ls && ds) {
    ls.disabled = t === "dark";
    ds.disabled = t !== "dark";
  }
}

// ============ 本地存储 ============
// 使用的 localStorage 键：quizTheme（主题）、quizView（当前视图）、quizBanks（题库列表）
// 记录当前视图，刷新后仍停留在同一页。
// 注意：只持久化视图名，答题进度、当前题库、作答模式都不持久化，
// 所以答题页与结果页本质上无法恢复，switchView 会在缺少题库时回退到首页。
function saveState() {
  try {
    localStorage.setItem("quizView", AppState.currentView);
  } catch (e) {}
}
function loadSavedView() {
  try {
    return localStorage.getItem("quizView") || "home";
  } catch (e) {
    return "home";
  }
}

// ============ 视图切换 ============
// 三个视图共用 #app 容器，切换即整体重绘
function switchView(view) {
  // 答题页与结果页都依赖当前题库，而题库不会被持久化（见 loadSavedView），
  // 因此刷新或重启后若恢复这两类视图，renderQuizView / renderResultView 会因
  // 题库为 null 抛错；此时 #app 已被清空，页面只剩顶部导航栏且无法自行恢复。
  // 故在没有题库时一律回退首页。
  if (!AppState.currentBank && (view === "quiz" || view === "result"))
    view = "home";

  AppState.currentView = view;
  var app = document.getElementById("app");
  app.innerHTML = "";
  app.className = "fade-in";
  if (view === "home") renderHomeView();
  else if (view === "quiz") renderQuizView();
  else if (view === "result") renderResultView();
  saveState();
}

// ============ 首页视图 ============
// 首页：当前题库概览 + 模式选择 + 导入导出 + 已保存题库列表
function renderHomeView() {
  var app = document.getElementById("app");
  var bank = AppState.currentBank;
  var banks = [];
  // 读取已保存的题库列表
  try {
    var d = localStorage.getItem("quizBanks");
    if (d) banks = JSON.parse(d);
  } catch (e) {}

  var html =
    '<div class="home-welcome"><h2>📝 在线刷题</h2><p>导入题库，选择模式，开始练习</p></div>';
  html += '<div class="home-bank-card">';

  if (bank) {
    // 按题型统计题量，用于展示题数徽章
    var counts = { single: 0, multi: 0, truefalse: 0, fill: 0, code: 0 };
    bank.questions.forEach(function (q) {
      counts[q.type] = (counts[q.type] || 0) + 1;
    });
    var stats =
      '<span class="stat-badge accent">' + bank.questions.length + " 题</span>";
    [
      "single",
      "multi",
      "truefalse",
      "fill",
      "code",
      "codefill",
      "programming",
    ].forEach(function (t) {
      if (counts[t] > 0)
        stats +=
          '<span class="stat-badge">' +
          counts[t] +
          " " +
          (TYPE_CN[t] || t) +
          "</span>";
    });
    html +=
      "<h2>" +
      escapeHtml(bank.title) +
      '</h2><div class="home-bank-stats">' +
      stats +
      "</div>";
  } else {
    html += "<h2>请选择或导入题库</h2>";
  }

  // 模式选择
  html += '<div class="mode-cards">';
  html +=
    '<div class="mode-card' +
    (AppState.mode === "instant" ? " selected" : "") +
    '" onclick="selectMode(\'instant\')"><span class="mode-icon">📖</span><h3>即时模式</h3><p>每答完一题立即显示答案和解析，适合学习和练习</p></div>';
  html +=
    '<div class="mode-card' +
    (AppState.mode === "batch" ? " selected" : "") +
    '" onclick="selectMode(\'batch\')"><span class="mode-icon">📝</span><h3>考试模式</h3><p>全部答完后才显示答案和解析，适合模拟考试</p></div>';
  html += "</div>";

  // 导入/导出
  html +=
    '<div class="home-actions" style="margin-bottom:16px"><button class="btn btn-primary" onclick="importBank()">📥 导入题库</button>';
  if (bank)
    html += '<button class="btn" onclick="exportBank()">📤 导出题库</button>';
  html += "</div>";

  // 题库列表
  banks.forEach(function (b) {
    var active = bank && bank.title === b.title;
    html +=
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--bg-secondary);border:2px solid ' +
      (active ? "var(--accent)" : "var(--border)") +
      ';border-radius:var(--radius-sm);margin-bottom:8px;cursor:pointer" onclick="loadBank(\'' +
      escapeAttr(b.title) +
      "')\">";
    html +=
      '<div style="display:flex;align-items:center;gap:10px"><span style="font-size:20px">📚</span><div><div style="font-weight:600;font-size:14px">' +
      escapeHtml(b.title) +
      '</div><div style="font-size:12px;color:var(--text-secondary)">' +
      b.questions.length +
      " 题</div></div></div>";
    html +=
      '<div style="display:flex;gap:4px"><button class="btn" style="padding:4px 10px;font-size:12px" onclick="event.stopPropagation();exportNamed(\'' +
      escapeAttr(b.title) +
      "')\">导出</button>";
    html +=
      '<button class="btn btn-danger" style="padding:4px 10px;font-size:12px" onclick="event.stopPropagation();deleteBank(\'' +
      escapeAttr(b.title) +
      "')\">删除</button></div></div>";
  });

  if (AppState.mode && bank) {
    html +=
      '<div style="text-align:center;margin-top:16px"><button class="btn btn-primary btn-lg" onclick="startQuiz()">🚀 开始刷题</button></div>';
  } else if (AppState.mode && !bank) {
    html +=
      '<div style="text-align:center;margin-top:16px;color:var(--text-muted);font-size:14px">请先选择或导入一个题库</div>';
  }
  html += "</div>";
  app.innerHTML = html;
}

// 选择刷题模式（"instant" 即时 / "batch" 考试）
function selectMode(mode) {
  AppState.mode = mode;
  switchView("home");
}
// 按标题从已保存的题库列表中载入题库
function loadBank(title) {
  try {
    var d = localStorage.getItem("quizBanks");
    if (!d) return;
    var found = JSON.parse(d).find(function (b) {
      return b.title === title;
    });
    if (found) {
      AppState.currentBank = found;
      switchView("home");
    }
  } catch (e) {}
}
// 把当前题库写回 localStorage：同标题则覆盖，否则追加
function saveBanks() {
  if (!AppState.currentBank) return;
  try {
    var d = localStorage.getItem("quizBanks");
    var banks = d ? JSON.parse(d) : [];
    var idx = banks.findIndex(function (b) {
      return b.title === AppState.currentBank.title;
    });
    if (idx >= 0) banks[idx] = AppState.currentBank;
    else banks.push(AppState.currentBank);
    localStorage.setItem("quizBanks", JSON.stringify(banks));
  } catch (e) {}
}
// 删除指定题库；若删的正是当前题库，一并清空引用
function deleteBank(title) {
  if (!confirm("确定删除题库「" + title + "」？")) return;
  try {
    var d = localStorage.getItem("quizBanks");
    if (!d) return;
    localStorage.setItem(
      "quizBanks",
      JSON.stringify(
        JSON.parse(d).filter(function (b) {
          return b.title !== title;
        }),
      ),
    );
  } catch (e) {}
  if (AppState.currentBank && AppState.currentBank.title === title)
    AppState.currentBank = null;
  showToast("已删除");
  switchView("home");
}

// ============ 导入 / 导出 ============
// 创建隐藏的 file input，选择 .md 文件后解析并保存为当前题库
function importBank() {
  var input = document.createElement("input");
  input.type = "file";
  input.accept = ".md,.markdown,.txt";
  input.onchange = function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (ev) {
      try {
        var bank = parseBank(ev.target.result);
        if (!bank.questions.length) {
          showToast("题库中没有找到题目");
          return;
        }
        AppState.currentBank = bank;
        saveBanks();
        showToast(
          "导入成功：" + bank.title + "（" + bank.questions.length + " 题）",
        );
        switchView("home");
      } catch (err) {
        showToast("解析失败：" + err.message);
      }
    };
    reader.readAsText(file, "UTF-8");
  };
  input.click();
}
// 导出当前题库
function exportBank() {
  if (!AppState.currentBank) {
    showToast("没有可导出的题库");
    return;
  }
  downloadMd(
    serializeBank(AppState.currentBank),
    AppState.currentBank.title + ".md",
  );
  showToast("已导出：" + AppState.currentBank.title + ".md");
}
// 按标题导出题库列表中的某个题库（首页列表的「导出」按钮）
function exportNamed(title) {
  try {
    var d = localStorage.getItem("quizBanks");
    if (!d) return;
    var bank = JSON.parse(d).find(function (b) {
      return b.title === title;
    });
    if (!bank) return;
    downloadMd(serializeBank(bank), title + ".md");
    showToast("已导出：" + title + ".md");
  } catch (e) {}
}
// 以 Blob 触发浏览器下载 .md 文件
function downloadMd(content, filename) {
  var blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============ 计时器 ============
// 答题用时计时器，每秒刷新 #timer 显示
function startTimer() {
  stopTimer();
  AppState.startTime = Date.now();
  AppState.endTime = null;
  updateTimer();
  AppState.timerInterval = setInterval(updateTimer, 1000);
}
function stopTimer() {
  if (AppState.timerInterval) {
    clearInterval(AppState.timerInterval);
    AppState.timerInterval = null;
  }
}
// 把已用毫秒数格式化为 mm:ss
function updateTimer() {
  var el = document.getElementById("timer");
  if (!el || !AppState.startTime) return;
  var e = Date.now() - AppState.startTime;
  el.textContent =
    String(Math.floor(e / 60000)).padStart(2, "0") +
    ":" +
    String(Math.floor((e % 60000) / 1000)).padStart(2, "0");
}

// ============ 答题视图 ============
// 重置答题进度并开始计时，进入答题页
function startQuiz() {
  if (!AppState.currentBank || !AppState.mode) return;
  AppState.currentIndex = 0;
  AppState.userAnswers = new Array(AppState.currentBank.questions.length).fill(
    "",
  );
  AppState.revealed = new Array(AppState.currentBank.questions.length).fill(
    false,
  );
  startTimer();
  switchView("quiz");
}

// 答题页：进度条 + 题目网格（题型筛选）+ 当前题目 + 上一题/下一题导航
function renderQuizView() {
  var app = document.getElementById("app");
  var bank = AppState.currentBank,
    total = bank.questions.length,
    idx = AppState.currentIndex;
  var answered = AppState.userAnswers.filter(function (a) {
    return a !== "";
  }).length;
  var pct = Math.round(((idx + 1) / total) * 100);
  var modeLabel = AppState.mode === "instant" ? "⚡ 即时模式" : "📝 考试模式";

  var html =
    '<div class="quiz-header"><div class="progress-bar-container"><div class="progress-bar-fill" style="width:' +
    pct +
    '%"></div></div>';
  html +=
    '<div class="quiz-progress-text"><span>第 ' +
    (idx + 1) +
    " / " +
    total +
    " 题</span><span>已答 " +
    answered +
    ' 题</span><span class="quiz-mode-badge">' +
    modeLabel +
    '</span><span id="timer" style="font-variant-numeric:tabular-nums">00:00</span></div></div>';
  // 题目网格与类型筛选（始终可见）
  var filterType = AppState.filterType || "all";
  html += '<div class="q-grid-panel">';
  html += '<div class="q-grid-filter-bar">';
  var fAll = filterType === "all" ? " filter-active" : "";
  html +=
    '<button class="q-filter-btn' +
    fAll +
    '" onclick="setFilter(\'all\')">全部</button>';
  var typeOrder = [
    "single",
    "multi",
    "truefalse",
    "fill",
    "code",
    "codefill",
    "programming",
  ];
  typeOrder.forEach(function (t) {
    var cnt = bank.questions.filter(function (q) {
      return q.type === t;
    }).length;
    if (cnt > 0) {
      var act = filterType === t ? " filter-active" : "";
      html +=
        '<button class="q-filter-btn' +
        act +
        '" onclick="setFilter(\'' +
        t +
        "')\">" +
        (TYPE_CN[t] || t) +
        '<span class="filter-count">' +
        cnt +
        "</span></button>";
    }
  });
  html += "</div>";
  html += '<div class="question-grid" id="q-grid">';
  var any = false;
  for (var i = 0; i < total; i++) {
    var qi = bank.questions[i];
    if (filterType !== "all" && qi.type !== filterType) continue;
    any = true;
    // 网格按钮状态：当前题高亮；已作答的题在即时模式下按对错着色，考试模式下仅标记「已答」
    var c = "q-grid-btn";
    if (i === idx) c += " current";
    else if (
      AppState.userAnswers[i] !== "" ||
      (AppState.mode === "instant" && AppState.revealed[i])
    ) {
      if (AppState.mode === "instant" && AppState.revealed[i]) {
        c += checkAnswer(qi, AppState.userAnswers[i])
          ? " grid-correct"
          : " grid-wrong";
      } else {
        c += " answered";
      }
    }
    html +=
      '<button class="' +
      c +
      '" onclick="jumpTo(' +
      i +
      ')">' +
      (i + 1) +
      "</button>";
  }
  if (!any)
    html +=
      '<span style="color:var(--text-muted);font-size:0.85rem;padding:8px">该题型下暂无题目</span>';
  html += '</div></div><div id="question-area"></div>';
  var isFirst = idx === 0,
    isLast = idx === total - 1;
  html +=
    '<div class="quiz-nav"><button class="btn" onclick="switchView(\'home\')">← 返回</button><div style="display:flex;gap:8px">';
  html +=
    '<button class="btn" onclick="navPrev()"' +
    (isFirst ? " disabled" : "") +
    ">← 上一题</button>";
  html +=
    '<button class="btn btn-primary" onclick="navNext()">' +
    (isLast ? "完成" : "下一题 →") +
    "</button></div></div>";
  if (AppState.mode === "batch") {
    html +=
      '<div class="batch-submit-area"><p>已答 ' +
      answered +
      " / " +
      total +
      ' 题</p><button class="btn btn-success btn-lg" onclick="submitBatch()">✅ 提交全部答案</button></div>';
  }
  app.innerHTML = html;
  renderQuestion(idx);
  updateTimer();
}

// 渲染第 idx 题到 #question-area；即时模式下已揭示的题目追加作答反馈与解析
function renderQuestion(idx) {
  var area = document.getElementById("question-area");
  if (!area) return;
  var q = AppState.currentBank.questions[idx],
    userAns = AppState.userAnswers[idx];
  var isRevealed = AppState.revealed[idx],
    isInstant = AppState.mode === "instant";
  var html =
    '<div class="question-card"><span class="question-type-tag ' +
    q.type +
    '">Q' +
    q.id +
    " · " +
    (TYPE_CN[q.type] || q.type) +
    '</span><div class="question-stem">' +
    renderMd(q.stem) +
    "</div>";
  if (q.type === "truefalse") html += renderTrueFalse(q, userAns, isRevealed);
  else if (q.type === "fill") html += renderFill(q, userAns, isRevealed);
  else if (q.type === "codefill")
    html += renderCodeFill(q, userAns, isRevealed);
  else if (q.type === "programming")
    html += renderProgramming(q, userAns, isRevealed);
  else html += renderOptions(q, userAns, isRevealed);
  if (isInstant && isRevealed) {
    html += renderAnswerFeedback(q, userAns);
    html += renderExplanationBox(q);
  }
  html += "</div>";
  area.innerHTML = html;
  highlightCode(area);
}

// 选择题选项列表（单选 / 多选 / 代码选择共用）。已揭示时标注正确项与误选项
function renderOptions(q, userAns, isRevealed) {
  var html = '<div class="options-list">';
  var correct = (q.answer || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .split("");
  var picked = userAns
    ? userAns
        .toUpperCase()
        .replace(/[^A-Z]/g, "")
        .split("")
    : [];
  q.choices.forEach(function (c) {
    var cls = "option-item";
    if (isRevealed) {
      cls += " disabled";
      if (correct.indexOf(c.letter) !== -1) cls += " correct";
      else if (picked.indexOf(c.letter) !== -1) cls += " wrong";
    } else if (picked.indexOf(c.letter) !== -1) cls += " selected";
    var oc = isRevealed ? "" : " onclick=\"selectAnswer('" + c.letter + "')\"";
    html +=
      '<div class="' +
      cls +
      '"' +
      oc +
      '><span class="option-marker">' +
      c.letter +
      '</span><span class="option-text">' +
      renderMd(c.text) +
      "</span></div>";
  });
  html += "</div>";
  // 多选题在即时模式下的确认按钮
  if (
    q.type === "multi" &&
    AppState.mode === "instant" &&
    !isRevealed &&
    userAns
  ) {
    html +=
      '<div style="margin-top:12px;text-align:right"><button class="btn btn-primary" onclick="confirmMulti()">✔ 确认选择（' +
      userAns.length +
      " 项）</button></div>";
  }
  return html;
}

// 判断题按钮（正确 / 错误）
function renderTrueFalse(q, userAns, isRevealed) {
  var ca = (q.answer || "").trim().toUpperCase();
  var html = '<div class="tf-options">';
  q.choices.forEach(function (c) {
    var cls = "tf-btn";
    if (isRevealed) {
      cls += " disabled";
      if (c.letter === ca) cls += " correct";
      else if (c.letter === userAns) cls += " wrong";
    } else if (c.letter === userAns) cls += " selected";
    var oc = isRevealed ? "" : " onclick=\"selectAnswer('" + c.letter + "')\"";
    html += '<button class="' + cls + '"' + oc + ">" + c.text + "</button>";
  });
  return html + "</div>";
}

// 统计题面中的空位数量：3 个及以上连续下划线算一个空位；
// 若题面只用 `___1___` 这类编号占位符，则退化为统计编号占位符个数
function countBlanks(stem) {
  var cleaned = stem.replace(/___\d+___/g, "");
  var m = cleaned.match(/_{3,}/g);
  if (m) return m.length;
  var leg = stem.match(/___\d+___/g);
  return leg ? leg.length : 0;
}

/**
 * 多空题的作答区（填空题与代码填空题共用）：按空位逐个渲染输入框。
 * 标准答案：用 | 分隔表示按空位顺序，用 || 分隔表示不限顺序，
 *           单个空位内用 / 分隔可接受的多种写法。
 * 用户答案为 JSON 数组字符串（见 collectFillAnswer）。
 * mono 为 true 时输入框使用等宽字体（代码填空题）。
 */
function renderMultiBlank(q, userAns, isRevealed, mono) {
  var ca = (q.answer || "").trim();
  var blankCount = countBlanks(q.stem);
  var showBtn = !isRevealed && AppState.mode === "instant";
  var unordered = ca.indexOf("||") !== -1;
  var ansParts = unordered
    ? ca.split("||").map(function (s) {
        return s.trim();
      })
    : ca.split("|").map(function (s) {
        return s.trim();
      });
  var userArr = [];
  try {
    if (userAns && userAns.charAt(0) === "[") userArr = JSON.parse(userAns);
  } catch (e) {}

  var inputStyle =
    ' style="width:160px' +
    (mono ? ";font-family:var(--font-mono);font-size:0.9rem" : "") +
    '"';
  var html =
    '<div class="fill-blanks-group" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center">';
  for (var i = 1; i <= blankCount; i++) {
    var val = userArr[i - 1] || "";
    var ic = "fill-input";
    if (isRevealed) {
      if (unordered) {
        // 无序模式：该值匹配任意一个空位的可接受答案即算对
        var anyMatch = false;
        var uVal = val.trim().toLowerCase();
        for (var k = 0; k < ansParts.length; k++) {
          var acc = ansParts[k].split("/").map(function (s) {
            return s.trim().toLowerCase();
          });
          if (acc.indexOf(uVal) !== -1) {
            anyMatch = true;
            break;
          }
        }
        ic += anyMatch ? " correct" : " wrong";
      } else {
        // 按序模式：该值需匹配对应空位的可接受答案
        var accepted = (ansParts[i - 1] || "").split("/").map(function (s) {
          return s.trim().toLowerCase();
        });
        ic +=
          accepted.indexOf(val.trim().toLowerCase()) !== -1
            ? " correct"
            : " wrong";
      }
    }
    var dis = isRevealed ? " disabled" : "";
    html +=
      '<div style="display:flex;align-items:center;gap:4px"><span style="font-weight:600;font-size:0.85rem;color:var(--text-secondary)">' +
      i +
      ".</span>" +
      '<input type="text" class="' +
      ic +
      '" data-blank="' +
      i +
      '" placeholder="第' +
      i +
      '空..." value="' +
      escapeAttr(val) +
      '"' +
      dis +
      inputStyle +
      "></div>";
  }
  if (showBtn)
    html +=
      '<button class="btn btn-primary" onclick="submitFill()">确认</button>';
  html += "</div>";

  if (isRevealed && !checkAnswer(q, userAns)) {
    var ansDisplay = unordered
      ? ansParts
          .map(function (a) {
            return escapeHtml(a);
          })
          .join(" / ")
      : ansParts
          .map(function (a, idx) {
            return idx + 1 + ". " + escapeHtml(a);
          })
          .join(" ");
    html +=
      '<div style="margin-top:8px;color:var(--success);font-size:0.9rem">正确答案：' +
      ansDisplay +
      (unordered ? "（任意顺序）" : "") +
      "</div>";
  }
  return html;
}

// 填空题输入区：多空走 renderMultiBlank，单空时答案可用 | 分隔罗列多种可接受写法
function renderFill(q, userAns, isRevealed) {
  var ca = (q.answer || "").trim();
  var blankCount = countBlanks(q.stem);
  var showBtn = !isRevealed && AppState.mode === "instant";

  if (blankCount > 1) return renderMultiBlank(q, userAns, isRevealed, false);

  // 单空模式：答案可用 | 分隔罗列多种可接受写法
  var ok = checkAnswer(q, userAns);
  var ic = "fill-input";
  if (isRevealed) ic += ok ? " correct" : " wrong";
  var dis = isRevealed ? " disabled" : "";
  var cd = "";
  if (isRevealed && !ok)
    cd =
      '<div style="margin-top:8px;color:var(--success);font-size:0.9rem">正确答案：' +
      escapeHtml(ca) +
      "</div>";
  return (
    '<div class="fill-input-group"><input type="text" class="' +
    ic +
    '" id="fill-answer" placeholder="输入答案..." value="' +
    escapeAttr(userAns) +
    '"' +
    dis +
    ">" +
    (showBtn
      ? '<button class="btn btn-primary" onclick="submitFill()">确认</button>'
      : "") +
    "</div>" +
    cd
  );
}

// 即时模式下答案揭示后的对错提示条
function renderAnswerFeedback(q, userAns) {
  if (checkAnswer(q, userAns))
    return (
      '<div class="answer-label correct">✔ 回答正确！答案：' +
      escapeHtml(q.answer) +
      "</div>"
    );
  return (
    '<div class="answer-label wrong">✘ 回答错误。你的答案：' +
    escapeHtml(userAns || "(未作答)") +
    " | 正确答案：" +
    escapeHtml(q.answer) +
    "</div>"
  );
}

// 代码填空题输入区：单空用多行代码文本域，多空走 renderMultiBlank（输入框用等宽字体）
function renderCodeFill(q, userAns, isRevealed) {
  var ca = (q.answer || "").trim();
  var blankCount = countBlanks(q.stem);
  var showBtn = !isRevealed && AppState.mode === "instant";

  if (blankCount > 1) return renderMultiBlank(q, userAns, isRevealed, true);

  // 单空模式：整段代码答案写在多行文本域中
  var ok = checkAnswer(q, userAns);
  var taCls = "code-fill-textarea";
  if (isRevealed) taCls += ok ? " correct" : " wrong";
  var dis = isRevealed ? " disabled" : "";
  var cd = "";
  if (isRevealed && !ok)
    cd =
      '<div style="margin-top:8px;color:var(--success);font-size:0.9rem">正确答案：<code style="font-family:var(--font-mono);background:var(--bg-code);padding:2px 6px;border-radius:4px">' +
      escapeHtml(ca) +
      "</code></div>";
  return (
    '<div class="code-fill-wrap">' +
    '<textarea class="' +
    taCls +
    '" id="fill-answer" rows="4" placeholder="在此输入代码答案..."' +
    dis +
    ">" +
    escapeHtml(userAns) +
    "</textarea>" +
    (showBtn
      ? '<div style="margin-top:8px;text-align:right"><button class="btn btn-primary" onclick="submitFill()">确认提交</button></div>'
      : "") +
    "</div>" +
    cd
  );
}

// 编程题输入区：大代码文本域 + 提交后对照参考答案。
// 编程题为自评题型，不作严格判分，仅供用户自行比对
function renderProgramming(q, userAns, isRevealed) {
  var ca = (q.answer || "").trim();
  var showBtn = !isRevealed && AppState.mode === "instant";
  var dis = isRevealed ? " disabled" : "";
  // 即时模式提交后 / 考试模式统一提交后，显示参考答案
  var refHtml = "";
  if (isRevealed) {
    var ok = checkAnswer(q, userAns);
    var label = ok
      ? '<div class="answer-label correct">✔ 自评通过</div>'
      : '<div class="answer-label wrong">⚠ 请对照参考解答</div>';
    refHtml =
      label +
      '<div style="margin-top:12px"><h4 style="color:var(--text-secondary);font-size:0.85rem;margin-bottom:6px">📖 参考解答</h4>' +
      '<pre style="background:var(--bg-code);border:1px solid var(--border);border-radius:var(--radius-sm);padding:14px;overflow-x:auto;max-height:400px;overflow-y:auto">' +
      '<code style="font-family:var(--font-mono);font-size:0.9rem;white-space:pre;background:none;padding:0">' +
      escapeHtml(ca) +
      "</code></pre></div>";
  }
  var placeholder = isRevealed
    ? "你的代码"
    : "在此编写代码...（支持 Tab 缩进）";
  return (
    '<div class="code-fill-wrap">' +
    '<textarea class="code-fill-textarea" id="fill-answer" rows="10" placeholder="' +
    placeholder +
    '"' +
    dis +
    ' style="min-height:200px;font-family:var(--font-mono);font-size:0.9rem;tab-size:4">' +
    escapeHtml(userAns) +
    "</textarea>" +
    (showBtn
      ? '<div style="margin-top:8px;text-align:right"><button class="btn btn-primary" onclick="submitFill()">提交查看参考解答</button></div>'
      : "") +
    "</div>" +
    refHtml
  );
}

// 解析框（题库中 `**解析：**` 之后的内容）
function renderExplanationBox(q) {
  if (!q.explanation) return "";
  return (
    '<div class="explanation-box"><h4>💡 解析</h4>' +
    renderMd(q.explanation) +
    "</div>"
  );
}

// ============ 答题交互 ============
// 选择题作答：多选为切换字母，单选为直接替换；
// 即时模式下单选/判断选中即揭示答案，多选需再点「确认选择」
function selectAnswer(letter) {
  var idx = AppState.currentIndex;
  if (AppState.revealed[idx]) return;
  var q = AppState.currentBank.questions[idx];
  if (q.type === "multi") {
    var cur = AppState.userAnswers[idx] || "",
      letters = cur.split("");
    var pos = letters.indexOf(letter);
    if (pos !== -1) letters.splice(pos, 1);
    else letters.push(letter);
    letters.sort();
    AppState.userAnswers[idx] = letters.join("");
  } else {
    AppState.userAnswers[idx] = letter;
  }
  if (AppState.mode === "instant" && q.type !== "multi")
    AppState.revealed[idx] = true;
  saveState();
  renderQuizView();
}
// 多选题在即时模式下点击「确认选择」后揭示答案
function confirmMulti() {
  var idx = AppState.currentIndex;
  if (!AppState.userAnswers[idx]) return;
  AppState.revealed[idx] = true;
  saveState();
  renderQuizView();
}
// 读取填空/代码填空/编程题的输入内容：
// 多空题返回 JSON 数组字符串（如 ["a","b"]），单空题返回纯文本；全空则返回 ""
function collectFillAnswer() {
  // 多空模式：存在 data-blank 输入框
  var blankInputs = document.querySelectorAll("[data-blank]");
  if (blankInputs.length > 0) {
    var arr = [];
    var hasAny = false;
    blankInputs.forEach(function (inp) {
      var v = inp.value.trim();
      arr.push(v);
      if (v) hasAny = true;
    });
    return hasAny ? JSON.stringify(arr) : "";
  }
  // 单空模式：#fill-answer 输入框或代码文本域
  var input = document.getElementById("fill-answer");
  return input ? input.value.trim() : "";
}
// 填空题/代码填空题「确认」按钮：记录答案并在即时模式下揭示
function submitFill() {
  var ans = collectFillAnswer();
  AppState.userAnswers[AppState.currentIndex] = ans;
  if (AppState.mode === "instant")
    AppState.revealed[AppState.currentIndex] = true;
  saveState();
  renderQuizView();
}
// 切换题目/视图前，先把输入框中尚未提交的内容存入 userAnswers
function saveCurrentFill() {
  var ans = collectFillAnswer();
  if (ans) AppState.userAnswers[AppState.currentIndex] = ans;
}
function navPrev() {
  saveCurrentFill();
  if (AppState.currentIndex > 0) {
    AppState.currentIndex--;
    saveState();
    renderQuizView();
  }
}
// 下一题；已是最后一题时，考试模式触发交卷，即时模式进入结果页
function navNext() {
  saveCurrentFill();
  var total = AppState.currentBank.questions.length;
  if (AppState.currentIndex < total - 1) {
    AppState.currentIndex++;
    saveState();
    renderQuizView();
  } else if (AppState.mode === "batch") submitBatch();
  else {
    AppState.endTime = Date.now();
    stopTimer();
    switchView("result");
  }
}
// 点击题目网格跳到指定题
function jumpTo(idx) {
  saveCurrentFill();
  AppState.currentIndex = idx;
  saveState();
  renderQuizView();
}
// 按题型筛选题目网格（"all" 表示不筛选）
function setFilter(type) {
  AppState.filterType = type;
  renderQuizView();
}
// 考试模式交卷：有未答题时先确认，然后停止计时并进入结果页
function submitBatch() {
  saveCurrentFill();
  var total = AppState.currentBank.questions.length;
  var answered = AppState.userAnswers.filter(function (a) {
    return a !== "";
  }).length;
  if (
    total - answered > 0 &&
    !confirm("还有 " + (total - answered) + " 题未作答，确定提交吗？")
  )
    return;
  AppState.endTime = Date.now();
  stopTimer();
  switchView("result");
}

/**
 * 判分：比较用户答案与题库标准答案，返回布尔值。
 * - 单选 / 判断题：忽略大小写比较
 * - 多选题：提取字母并排序后比较，与选择顺序无关
 * - 填空 / 代码填空 / 编程题：忽略大小写与首尾空格；
 *   单空答案用 | 罗列多种可接受写法；
 *   多空的用户答案为 JSON 数组字符串（见 collectFillAnswer），
 *   标准答案中 | 表示按空位顺序、|| 表示不限顺序，单个空位内用 / 分隔可接受写法。
 * 注：编程题此处只做精确匹配，用户极难与参考解答完全一致，实际按自评处理。
 */
function checkAnswer(q, userAns) {
  if (!userAns) return false;
  var ua = userAns.trim(),
    ca = (q.answer || "").trim();
  if (q.type === "multi")
    return (
      ua
        .toUpperCase()
        .replace(/[^A-Z]/g, "")
        .split("")
        .sort()
        .join("") ===
      ca
        .toUpperCase()
        .replace(/[^A-Z]/g, "")
        .split("")
        .sort()
        .join("")
    );
  if (q.type === "fill" || q.type === "codefill" || q.type === "programming") {
    // 用户答案以 "[" 开头，说明是多空题（JSON 数组字符串）
    if (ua.charAt(0) === "[") {
      // 多空模式
      try {
        var userArr = JSON.parse(ua);
        // 标准答案含 || 即不限填写顺序
        var unordered = ca.indexOf("||") !== -1;
        var ansParts = unordered
          ? ca.split("||").map(function (s) {
              return s.trim();
            })
          : ca.split("|").map(function (s) {
              return s.trim();
            });
        if (userArr.length !== ansParts.length) return false;
        if (!unordered) {
          // 按序模式：逐个空位比对
          for (var i = 0; i < userArr.length; i++) {
            var accepted = ansParts[i].split("/").map(function (s) {
              return s.trim().toLowerCase();
            });
            if (
              accepted.indexOf((userArr[i] || "").trim().toLowerCase()) === -1
            )
              return false;
          }
          return true;
        }
        // 乱序模式：每个空位都要被某个答案匹配上，用回溯做一一配对
        var used = {};
        function tryMatch(idx) {
          if (idx >= userArr.length) return true;
          var uVal = (userArr[idx] || "").trim().toLowerCase();
          for (var j = 0; j < ansParts.length; j++) {
            if (used[j]) continue;
            var acc = ansParts[j].split("/").map(function (s) {
              return s.trim().toLowerCase();
            });
            if (acc.indexOf(uVal) !== -1) {
              used[j] = true;
              if (tryMatch(idx + 1)) return true;
              delete used[j];
            }
          }
          return false;
        }
        return tryMatch(0);
      } catch (e) {
        return false;
      }
    }
    // 单空题：标准答案可用 | 罗列多种可接受写法
    var acceptable = ca.split("|").map(function (s) {
      return s.trim().toLowerCase();
    });
    return acceptable.indexOf(ua.toLowerCase()) !== -1;
  }
  // 单选 / 判断题
  return ua.toUpperCase() === ca.toUpperCase();
}

// ============ 结果视图 ============
// 结果页：得分总览 + 答题回顾列表（可按对/错/未答筛选）
function renderResultView() {
  var app = document.getElementById("app"),
    bank = AppState.currentBank,
    total = bank.questions.length;
  var correct = 0,
    wrong = 0,
    skipped = 0;
  bank.questions.forEach(function (q, i) {
    if (!AppState.userAnswers[i]) skipped++;
    else if (checkAnswer(q, AppState.userAnswers[i])) correct++;
    else wrong++;
  });
  var pct = Math.round((correct / total) * 100);
  // 分档：≥90 优秀 / ≥70 良好 / ≥50 及格 / 其余较差，决定得分圆环配色与文案
  var grade =
    pct >= 90
      ? "excellent"
      : pct >= 70
        ? "good"
        : pct >= 50
          ? "needs-work"
          : "poor";
  var barColor =
    pct >= 90
      ? "var(--success)"
      : pct >= 70
        ? "var(--accent)"
        : pct >= 50
          ? "var(--warning)"
          : "var(--danger)";
  var emoji = pct >= 90 ? "🏆" : pct >= 70 ? "👏" : pct >= 50 ? "💪" : "😢";
  var elapsed =
    (AppState.endTime || Date.now()) - (AppState.startTime || Date.now());
  var ts =
    String(Math.floor(elapsed / 60000)).padStart(2, "0") +
    ":" +
    String(Math.floor((elapsed % 60000) / 1000)).padStart(2, "0");

  var html =
    '<div class="result-hero"><div class="result-score-circle ' +
    grade +
    '"><span class="result-percentage">' +
    pct +
    '<span class="result-percentage-sign">%</span></span></div>';
  html +=
    '<div class="result-detail-text">' +
    emoji +
    " 共 " +
    total +
    " 题，答对 " +
    correct +
    " 题</div>";
  html +=
    '<div class="result-bar"><div class="result-bar-fill" style="width:' +
    pct +
    "%;background:" +
    barColor +
    '"></div></div>';
  html +=
    '<div style="display:flex;justify-content:center;gap:24px;margin-top:20px">';
  html +=
    '<div><strong style="color:var(--success)">' +
    correct +
    '</strong><br><small style="color:var(--text-secondary)">正确</small></div>';
  html +=
    '<div><strong style="color:var(--danger)">' +
    wrong +
    '</strong><br><small style="color:var(--text-secondary)">错误</small></div>';
  html +=
    '<div><strong style="color:var(--text-muted)">' +
    skipped +
    '</strong><br><small style="color:var(--text-secondary)">未答</small></div>';
  html +=
    "<div><strong>" +
    ts +
    '</strong><br><small style="color:var(--text-secondary)">用时</small></div></div>';
  html +=
    '<div class="result-actions"><button class="btn btn-primary" onclick="retryQuiz()">🔄 重新答题</button><button class="btn" onclick="switchView(\'home\')">🏠 返回首页</button></div></div>';

  // 回顾列表：卡片先全部渲染，再由筛选按钮/脚本控制显隐
  var revFilter = AppState.reviewFilter || "all";
  html += '<div class="review-section"><h3>📋 答题回顾</h3>';
  html += '<div class="q-grid-filter-bar" style="margin-bottom:12px">';
  var rfAll = revFilter === "all" ? " filter-active" : "";
  html +=
    '<button class="q-filter-btn' +
    rfAll +
    '" onclick="setReviewFilter(\'all\')">全部<span class="filter-count">' +
    total +
    "</span></button>";
  if (correct > 0) {
    var rfC = revFilter === "correct" ? " filter-active" : "";
    html +=
      '<button class="q-filter-btn' +
      rfC +
      '" onclick="setReviewFilter(\'correct\')">✅ 答对<span class="filter-count">' +
      correct +
      "</span></button>";
  }
  if (wrong > 0) {
    var rfW = revFilter === "wrong" ? " filter-active" : "";
    html +=
      '<button class="q-filter-btn' +
      rfW +
      '" onclick="setReviewFilter(\'wrong\')">❌ 答错<span class="filter-count">' +
      wrong +
      "</span></button>";
  }
  if (skipped > 0) {
    var rfS = revFilter === "skipped" ? " filter-active" : "";
    html +=
      '<button class="q-filter-btn' +
      rfS +
      '" onclick="setReviewFilter(\'skipped\')">⏭️ 未答<span class="filter-count">' +
      skipped +
      "</span></button>";
  }
  html += "</div>";
  bank.questions.forEach(function (q, i) {
    var ua = AppState.userAnswers[i],
      ok = checkAnswer(q, ua);
    var status = !ua ? "skipped" : ok ? "correct" : "wrong";
    var hidden =
      revFilter !== "all" && revFilter !== status
        ? ' style="display:none"'
        : "";
    var icon = !ua ? "⏭️" : ok ? "✅" : "❌";
    html +=
      '<div class="review-card" data-review-status="' +
      status +
      '"' +
      hidden +
      ">";
    html +=
      '<div class="review-card-header"><span class="review-icon">' +
      icon +
      '</span><span class="review-q-id">Q' +
      q.id +
      " [" +
      (TYPE_CN[q.type] || q.type) +
      "]</span></div>";
    html +=
      '<div class="review-answers"><span>你的答案：<strong>' +
      escapeHtml(ua || "未作答") +
      "</strong></span><span>正确答案：<strong>" +
      escapeHtml(q.answer) +
      "</strong></span></div>";
    html +=
      '<button class="review-toggle" onclick="toggleReview(this)">查看解析 ▼</button>';
    html +=
      '<div class="review-detail"><div class="question-stem">' +
      renderMd(q.stem) +
      "</div>";
    if (q.explanation)
      html +=
        '<div class="explanation-box">' + renderMd(q.explanation) + "</div>";
    html += "</div></div>";
  });
  html += "</div>";
  app.innerHTML = html;
  highlightCode(app);
}

// 结果页回顾筛选：只显示命中状态的卡片（不重新渲染，仅切换 display）
function setReviewFilter(type) {
  AppState.reviewFilter = type;
  var cards = document.querySelectorAll(".review-card");
  cards.forEach(function (c) {
    var st = c.getAttribute("data-review-status");
    c.style.display = type === "all" || type === st ? "" : "none";
  });
  // 同步筛选按钮的选中态（按按钮文字包含的标签匹配）
  var btns = document.querySelectorAll(".review-section .q-filter-btn");
  btns.forEach(function (b) {
    b.classList.toggle(
      "filter-active",
      b.textContent.indexOf(
        { all: "全部", correct: "答对", wrong: "答错", skipped: "未答" }[type],
      ) !== -1,
    );
  });
}
// 展开/收起单张回顾卡片下的题面与解析
function toggleReview(btn) {
  var d = btn.nextElementSibling;
  if (d.classList.contains("open")) {
    d.classList.remove("open");
    btn.textContent = "查看解析 ▼";
  } else {
    d.classList.add("open");
    btn.textContent = "收起解析 ▲";
    highlightCode(d);
  }
}
// 重做当前题库：重置进度并重新计时
function retryQuiz() {
  if (!AppState.currentBank) return;
  AppState.currentIndex = 0;
  AppState.userAnswers = new Array(AppState.currentBank.questions.length).fill(
    "",
  );
  AppState.revealed = new Array(AppState.currentBank.questions.length).fill(
    false,
  );
  startTimer();
  switchView("quiz");
}

// ============ 初始化 ============
// 页面加载：应用主题并恢复到上次所在的视图
document.addEventListener("DOMContentLoaded", function () {
  applyTheme();
  switchView(loadSavedView());
});

// 代码文本域（编程题、代码填空题）内的 Tab 缩进支持，
// 阻止默认的焦点切换行为，改为插入或删除 4 个空格
document.addEventListener("keydown", function (e) {
  if (e.key === "Tab") {
    var el = e.target;
    if (
      el.tagName === "TEXTAREA" &&
      el.classList.contains("code-fill-textarea")
    ) {
      e.preventDefault();
      var start = el.selectionStart,
        end = el.selectionEnd;
      var before = el.value.substring(0, start);
      var after = el.value.substring(end);
      if (!e.shiftKey) {
        // Tab：在光标处插入 4 个空格（不使用制表符，保证与题面缩进一致）
        el.value = before + "    " + after;
        el.selectionStart = el.selectionEnd = start + 4;
      } else {
        // Shift+Tab：删除当前行行首的缩进（最多 4 个空格或 1 个制表符）
        var lineStart = before.lastIndexOf("\n") + 1;
        var leading = before.substring(lineStart);
        var trimLen = 0;
        if (leading.startsWith("    ")) {
          trimLen = 4;
        } else if (leading.startsWith("\t")) {
          trimLen = 1;
        } else if (leading.startsWith("   ")) {
          trimLen = 3;
        } else if (leading.startsWith("  ")) {
          trimLen = 2;
        } else if (leading.startsWith(" ")) {
          trimLen = 1;
        }
        if (trimLen > 0) {
          el.value =
            before.substring(0, lineStart) + leading.substring(trimLen) + after;
          el.selectionStart = el.selectionEnd = start - trimLen;
        }
      }
    }
  }
});
