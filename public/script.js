const chat = document.getElementById('chat');
const form = document.getElementById('form');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const emergency = document.getElementById('emergency');
const consent = document.getElementById('consent');
const agree = document.getElementById('agree');
const startBtn = document.getElementById('start');

// Anonymous session id, lives only in this browser tab
const historyLog = [];
const sessionId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

agree.addEventListener('change', () => { startBtn.disabled = !agree.checked; });
startBtn.addEventListener('click', () => {
  consent.classList.add('hide');
  addMessage('bot', 'Hello. I am a mental health support chatbot. How are you feeling today, and what have you noticed in yourself or someone close to you?');
  input.focus();
});

function addMessage(who, text, extra = '') {
  const div = document.createElement('div');
  div.className = 'msg ' + who + (extra ? ' ' + extra : '');
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  addMessage('user', text);
  input.value = '';
  sendBtn.disabled = true;
  const typing = addMessage('bot', 'Typing...', 'typing');
  try {
    const res = await fetch('/.netlify/functions/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, sessionId, history: historyLog.slice(-6) })
    });
    const data = await res.json();
    typing.remove();
    addMessage('bot', data.reply || 'Sorry, something went wrong. Please try again.');
    historyLog.push({ role: 'user', text }, { role: 'bot', text: data.reply || '' });
    if (data.level && data.level !== 'none') {
      addMessage('bot', 'Screening level: ' + data.level.toUpperCase() + ' (a preliminary indication, not a diagnosis)', 'level level-' + data.level);
    }
    if (data.emergency) emergency.hidden = false;
  } catch (err) {
    typing.remove();
    addMessage('bot', 'I could not connect just now. If this is urgent, call 112 or go to the nearest hospital.');
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
});
