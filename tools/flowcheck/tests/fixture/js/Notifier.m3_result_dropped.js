class Notifier { sendSms(text) { const phone = this.getPhone(); this.validatePhone(phone); this.send(phone, text); } getPhone() { return ""; } send() {} validatePhone() { return true; } }
