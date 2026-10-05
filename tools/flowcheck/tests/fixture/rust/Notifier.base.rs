struct Notifier;
impl Notifier { fn send_sms(&self, id: u32, text: &str) -> Result<(), ()> { let phone = self.get_phone(id)?; self.send(&phone, text); Ok(()) } fn get_phone(&self, _: u32) -> Result<String, ()> { Ok("1".into()) } fn send(&self, _: &str, _: &str) {} }
