
const esc=(s)=>String(s??"").replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const rows=(a,f)=>a.map(f).join("");
const hue=(s)=>{let h=0;for(const c of String(s))h=(h*31+c.charCodeAt(0))%360;return h;};
async function tick(){
  try{
    const d=await (await fetch("/api/monitor")).json();
    const ph={working:["作業中","#fbbf24"],done:["完了","#86efac"],idle:["待機","#6e6e73"]}[d.phase]||["?","#6e6e73"];
    const remain=d.tasks.open.length+d.tasks.claimed.length;
    const pe=document.getElementById("phase");
    pe.textContent=ph[0]+(d.phase==="working"?"(残り"+remain+"件)":"");
    pe.style.color=ph[1];
    document.getElementById("meta").textContent="model: "+d.model+" / perm:"+esc(d.permMode)+" / 稼働 "+Math.floor(d.uptimeSec/60)+"分"+(d.uptimeSec%60)+"秒 / 投稿 "+d.posts+"件"+(d.lastActivitySec!=null?" / 最終活動 "+(d.lastActivitySec<60?d.lastActivitySec+"秒前":Math.floor(d.lastActivitySec/60)+"分前"):"");
    document.getElementById("body").innerHTML=
      "<h2>スレッド</h2><table><tr><th>状態</th><th>名前</th><th>フォルダ</th><th>進捗</th><th>メンバー</th><th>目標</th></tr>"+
      (rows(d.threads,(t)=>{const st={done:["完了","#86efac"],working:["作業中","#fbbf24"],waiting:["未着手","#a3a3a8"],idle:["—","#6e6e73"]}[t.state]||["—","#6e6e73"];const ps=t.paused?"<span class='warn'>[停止中]</span> ":"";return "<tr><td>"+ps+"<span style='color:"+st[1]+"'>"+st[0]+"</span></td><td class='mono'># "+esc(t.name)+"</td><td>"+esc(t.folder??"")+"</td><td><div class='bar'><i style='width:"+t.percent+"%'></i></div><span class='dim mono'>"+t.done+"/"+t.total+"</span></td><td>"+rows(t.members??[],(m)=>{const sc={idle:"#a3a3a8",working:"#fbbf24",done:"#86efac",error:"#fca5a5","budget-stop":"#fca5a5"}[m.status]||"#a3a3a8";return "<span class='mem1' title='"+esc(m.status)+"'><i class='mdot' style='background:"+sc+"'></i><span style='color:hsl("+hue(m.id)+" 45% 72%)'>"+esc(m.displayName)+"</span></span>";})+"</td><td class='dim'>"+esc(t.goal)+"</td></tr>";})||"<tr><td colspan='6' class='dim'>開いているスレッドはありません</td></tr>")+"</table>"+
      "<h2>タスク(未着手 "+d.tasks.open.length+" / 作業中 "+d.tasks.claimed.length+" / 完了 "+d.tasks.doneCount+")</h2><table><tr><th>状態</th><th>タスク</th><th>担当</th><th>内容</th></tr>"+
      rows(d.tasks.claimed,(t)=>"<tr><td class='warn'>作業中</td><td class='mono'>"+esc(t.id)+"</td><td class='mono'>"+esc(t.agent)+"</td><td class='dim'>"+esc(t.summary)+"</td></tr>")+
      rows(d.tasks.open,(t)=>"<tr><td class='dim'>未着手</td><td class='mono'>"+esc(t.id)+"</td><td></td><td class='dim'>"+esc(t.summary)+"</td></tr>")+"</table>"+
      "<h2>エージェント</h2><table><tr><th>名前</th><th>状態</th><th>turn</th><th>直近ツール</th><th>消費</th><th>スレッド</th></tr>"+
      (rows(d.agents,(a)=>{const st={idle:["待機","#a3a3a8"],working:["作業中","#fbbf24"],done:["完了","#86efac"],error:["エラー","#fca5a5"],"budget-stop":["停止","#fca5a5"]}[a.status]||[esc(a.status),"#a3a3a8"];return "<tr><td style='color:hsl("+hue(a.id)+" 45% 72%)'>"+esc(a.displayName)+"</td><td style='color:"+st[1]+"'>"+st[0]+"</td><td class='mono'>"+a.turn+"</td><td class='mono'>"+esc(a.lastTool)+"</td><td class='mono'>"+a.tokens.toLocaleString()+"tok</td><td class='mono'>"+esc(a.thread)+"</td></tr>";})||"<tr><td colspan='6' class='dim'>稼働中のエージェントはいません</td></tr>")+"</table>"+
      "<h2>通知(承認待ち/マージ/長時間タスク)</h2><div class='board'>"+(rows(d.pendingRequests??[],(r)=>"<div class='warn'><b>🔐 承認待ち #"+esc(r.id)+"</b> <span class='mono'>"+esc(r.command)+"</span></div>")||"")+(rows(d.notifications??[],(n)=>"<div>"+(n.kind==="permission.request"?"<b class='warn'>🔐 "+esc(n.title)+"</b>":(n.kind==="merge.completed"?"<b class='ok'>🔀 "+esc(n.title)+"</b>":"<b>⏱ "+esc(n.title)+"</b>"))+" <span>"+esc(n.body)+"</span> <span class='dim mono'>"+esc(String(n.at).replace("T"," ").slice(0,19))+"</span></div>"))||"<div class='dim'>まだありません</div>")+"</div>"+
      "<h2>直近のマージ</h2><div class='board'>"+(rows(d.merges,(m)=>"<div><b class='mono'>"+esc(m.taskId)+"</b> <span class='accent'>"+esc(m.summary)+"</span> <span class='dim'>by "+esc(m.agent)+"</span></div>")||"<div class='dim'>まだありません</div>")+"</div>"+
      "<h2>ボードの新着(全スレッド・直近30件)</h2><div class='board'>"+rows(d.recent.slice().reverse(),(p)=>"<div><b style='color:hsl("+hue(p.from)+" 45% 72%)'>"+esc(p.from)+"</b> <span class='mono dim'>@"+esc(p.thread)+"</span> "+esc(p.text)+"</div>")+"</div>";
  }catch(e){ document.getElementById("body").textContent="取得に失敗: "+e.message; }
}
tick();setInterval(tick,3000);
