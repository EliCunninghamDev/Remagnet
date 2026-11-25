//! Minimal XML-RPC codec shared by the rTorrent client.
//!
//! The wire format is small enough that a full XML-RPC crate would be overkill,
//! but the XML itself still needs a real parser. `quick-xml` handles tokenizing
//! and escaping so this module only maps XML-RPC values on top of its events.

use std::{collections::HashMap, io};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use quick_xml::{
    events::{BytesDecl, BytesEnd, BytesRef, BytesStart, BytesText, Event},
    Reader, Writer,
};

/// Upper bound on nested XML-RPC containers to protect the parser stack.
pub const MAX_XML_DEPTH: usize = 32;

/// An XML-RPC value as it appears on the wire.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    String(String),
    Int(i64),
    Bool(bool),
    Double(f64),
    Base64(Vec<u8>),
    Array(Vec<Value>),
    Struct(HashMap<String, Value>),
    Nil,
}

impl Value {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value.as_str()),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Int(value) => Some(*value),
            Self::Bool(value) => Some(i64::from(*value)),
            Self::String(value) => value.trim().parse::<i64>().ok(),
            _ => None,
        }
    }

    pub fn as_u64(&self) -> Option<u64> {
        self.as_i64().map(|value| value.max(0) as u64)
    }

    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Self::Array(values) => Some(values.as_slice()),
            _ => None,
        }
    }
}

/// Why an XML-RPC document could not be turned into a [`Value`].
#[derive(Debug, PartialEq, Eq)]
pub enum ParseError {
    /// The peer sent a well-formed `<fault>` response.
    Fault { code: i64, message: String },
    /// The document was not valid XML-RPC.
    Malformed(String),
}

/// Encode a `<methodCall>` document.
pub fn encode_call(method: &str, params: &[Value]) -> String {
    let mut writer = Writer::new(Vec::new());
    write_declaration(&mut writer);

    writer
        .create_element("methodCall")
        .write_inner_content(|writer| {
            writer
                .create_element("methodName")
                .write_text_content(BytesText::new(method))?;
            writer
                .create_element("params")
                .write_inner_content(|writer| {
                    for param in params {
                        writer
                            .create_element("param")
                            .write_inner_content(|writer| encode_value(writer, param))?;
                    }
                    Ok(())
                })?;
            Ok(())
        })
        .expect("writing XML-RPC to memory cannot fail");

    into_string(writer)
}

/// Parse the single value carried by a `<methodResponse>` document.
pub fn parse_response(xml: &str) -> Result<Value, ParseError> {
    let mut parser = Parser::new(xml)?;

    if parser.expect_start("methodResponse")? {
        return Err(ParseError::Malformed("empty <methodResponse/>".to_string()));
    }

    parser.skip_ignorable();
    let event = parser.peek().clone();
    match event {
        Event::Start(element) if tag_name(&element) == "fault" => {
            parser.pos += 1;
            let value = parser.parse_value(0)?;
            parser.expect_end("fault")?;
            parser.expect_end("methodResponse")?;

            let (code, message) = match value {
                Value::Struct(map) => (
                    map.get("faultCode").and_then(Value::as_i64).unwrap_or(0),
                    map.get("faultString")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown XML-RPC fault")
                        .trim()
                        .to_string(),
                ),
                _ => (0, "unknown XML-RPC fault".to_string()),
            };
            Err(ParseError::Fault { code, message })
        }
        Event::Empty(element) if tag_name(&element) == "params" => {
            parser.pos += 1;
            parser.expect_end("methodResponse")?;
            Ok(Value::Nil)
        }
        Event::Start(element) if tag_name(&element) == "params" => {
            parser.pos += 1;
            let value = parser.parse_response_params()?;
            parser.expect_end("methodResponse")?;
            Ok(value)
        }
        _ => Err(ParseError::Malformed(
            "expected <params> or <fault> inside <methodResponse>".to_string(),
        )),
    }
}

/// Encode a `<methodResponse>` document carrying a single value.
#[cfg(test)]
pub fn encode_response(value: &Value) -> String {
    let mut writer = Writer::new(Vec::new());
    write_declaration(&mut writer);

    writer
        .create_element("methodResponse")
        .write_inner_content(|writer| {
            writer
                .create_element("params")
                .write_inner_content(|writer| {
                    writer
                        .create_element("param")
                        .write_inner_content(|writer| encode_value(writer, value))?;
                    Ok(())
                })?;
            Ok(())
        })
        .expect("writing XML-RPC to memory cannot fail");

    into_string(writer)
}

/// Encode a `<fault>` response.
#[cfg(test)]
pub fn encode_fault(code: i64, message: &str) -> String {
    let mut members = HashMap::new();
    members.insert("faultCode".to_string(), Value::Int(code));
    members.insert(
        "faultString".to_string(),
        Value::String(message.to_string()),
    );
    let value = Value::Struct(members);

    let mut writer = Writer::new(Vec::new());
    write_declaration(&mut writer);

    writer
        .create_element("methodResponse")
        .write_inner_content(|writer| {
            writer
                .create_element("fault")
                .write_inner_content(|writer| encode_value(writer, &value))?;
            Ok(())
        })
        .expect("writing XML-RPC to memory cannot fail");

    into_string(writer)
}

/// Parse a `<methodCall>` document, returning its method name and parameters.
#[cfg(test)]
pub fn parse_call(xml: &str) -> Result<(String, Vec<Value>), ParseError> {
    let mut parser = Parser::new(xml)?;

    if parser.expect_start("methodCall")? {
        return Err(ParseError::Malformed("empty <methodCall/>".to_string()));
    }

    let method = if parser.expect_start("methodName")? {
        String::new()
    } else {
        parser.read_text_until_close("methodName")?
    };

    let mut params = Vec::new();
    parser.skip_ignorable();
    match parser.peek().clone() {
        Event::Empty(element) if tag_name(&element) == "params" => {
            parser.pos += 1;
        }
        Event::Start(element) if tag_name(&element) == "params" => {
            parser.pos += 1;
            loop {
                parser.skip_ignorable();
                match parser.peek().clone() {
                    Event::End(element) if end_name(&element) == "params" => {
                        parser.pos += 1;
                        break;
                    }
                    Event::Start(element) if tag_name(&element) == "param" => {
                        parser.pos += 1;
                        params.push(parser.parse_value(0)?);
                        parser.expect_end("param")?;
                    }
                    _ => {
                        return Err(ParseError::Malformed(
                            "unexpected token inside <params>".to_string(),
                        ));
                    }
                }
            }
        }
        _ => {
            return Err(ParseError::Malformed(
                "expected <params> inside <methodCall>".to_string(),
            ));
        }
    }

    parser.expect_end("methodCall")?;
    Ok((method, params))
}

fn write_declaration(writer: &mut Writer<Vec<u8>>) {
    writer
        .write_event(Event::Decl(BytesDecl::new("1.0", Some("UTF-8"), None)))
        .expect("writing XML-RPC to memory cannot fail");
}

fn into_string(writer: Writer<Vec<u8>>) -> String {
    String::from_utf8(writer.into_inner()).expect("quick-xml writes valid UTF-8")
}

fn encode_value(writer: &mut Writer<Vec<u8>>, value: &Value) -> io::Result<()> {
    writer
        .create_element("value")
        .write_inner_content(|writer| {
            match value {
                Value::String(text) => {
                    writer
                        .create_element("string")
                        .write_text_content(BytesText::new(text))?;
                }
                Value::Int(number) => {
                    let (tag, text) = if i32::try_from(*number).is_ok() {
                        ("i4", number.to_string())
                    } else {
                        ("i8", number.to_string())
                    };
                    writer
                        .create_element(tag)
                        .write_text_content(BytesText::new(&text))?;
                }
                Value::Bool(flag) => {
                    let text = if *flag { "1" } else { "0" };
                    writer
                        .create_element("boolean")
                        .write_text_content(BytesText::new(text))?;
                }
                Value::Double(number) => {
                    let text = number.to_string();
                    writer
                        .create_element("double")
                        .write_text_content(BytesText::new(&text))?;
                }
                Value::Base64(bytes) => {
                    let text = BASE64.encode(bytes);
                    writer
                        .create_element("base64")
                        .write_text_content(BytesText::new(&text))?;
                }
                Value::Array(items) => {
                    writer
                        .create_element("array")
                        .write_inner_content(|writer| {
                            writer
                                .create_element("data")
                                .write_inner_content(|writer| {
                                    for item in items {
                                        encode_value(writer, item)?;
                                    }
                                    Ok(())
                                })?;
                            Ok(())
                        })?;
                }
                Value::Struct(members) => {
                    writer
                        .create_element("struct")
                        .write_inner_content(|writer| {
                            for (name, member) in members {
                                writer
                                    .create_element("member")
                                    .write_inner_content(|writer| {
                                        writer
                                            .create_element("name")
                                            .write_text_content(BytesText::new(name))?;
                                        encode_value(writer, member)
                                    })?;
                            }
                            Ok(())
                        })?;
                }
                Value::Nil => {
                    writer.create_element("nil").write_empty()?;
                }
            }
            Ok(())
        })?;
    Ok(())
}

struct Parser {
    events: Vec<Event<'static>>,
    pos: usize,
}

impl Parser {
    fn new(xml: &str) -> Result<Self, ParseError> {
        let mut reader = Reader::from_str(xml);
        reader.config_mut().check_end_names = true;

        let mut events = Vec::new();
        loop {
            match reader.read_event() {
                Ok(Event::Eof) => {
                    events.push(Event::Eof);
                    break;
                }
                Ok(event) => events.push(event.into_owned()),
                Err(error) => {
                    return Err(ParseError::Malformed(format!("invalid XML: {error}")));
                }
            }
        }

        Ok(Self { events, pos: 0 })
    }

    fn peek(&self) -> &Event<'static> {
        &self.events[self.pos.min(self.events.len().saturating_sub(1))]
    }

    fn next_event(&mut self) -> Event<'static> {
        let event = self.peek().clone();
        if self.pos < self.events.len() {
            self.pos += 1;
        }
        event
    }

    fn skip_ignorable(&mut self) {
        loop {
            match self.peek() {
                Event::Text(text) if text.iter().all(|byte| byte.is_ascii_whitespace()) => {
                    self.pos += 1;
                }
                Event::Comment(_) | Event::Decl(_) | Event::PI(_) | Event::DocType(_) => {
                    self.pos += 1;
                }
                _ => break,
            }
        }
    }

    fn open_element(&mut self) -> Result<(String, bool), ParseError> {
        self.skip_ignorable();
        match self.next_event() {
            Event::Start(element) => Ok((tag_name(&element), false)),
            Event::Empty(element) => Ok((tag_name(&element), true)),
            other => Err(ParseError::Malformed(format!(
                "expected an opening tag, got {other:?}"
            ))),
        }
    }

    fn expect_start(&mut self, expected: &str) -> Result<bool, ParseError> {
        let (name, empty) = self.open_element()?;
        if name != expected {
            return Err(ParseError::Malformed(format!(
                "expected <{expected}>, got <{name}>"
            )));
        }
        Ok(empty)
    }

    fn expect_end(&mut self, expected: &str) -> Result<(), ParseError> {
        self.skip_ignorable();
        match self.next_event() {
            Event::End(element) if end_name(&element) == expected => Ok(()),
            other => Err(ParseError::Malformed(format!(
                "expected </{expected}>, got {other:?}"
            ))),
        }
    }

    fn read_text_until_close(&mut self, expected: &str) -> Result<String, ParseError> {
        let mut out = String::new();
        loop {
            match self.next_event() {
                Event::Text(text) => {
                    let decoded = text
                        .decode()
                        .map_err(|error| malformed(format!("invalid text encoding: {error}")))?;
                    out.push_str(&decoded);
                }
                Event::CData(text) => {
                    let decoded = text
                        .decode()
                        .map_err(|error| malformed(format!("invalid CDATA encoding: {error}")))?;
                    out.push_str(&decoded);
                }
                Event::GeneralRef(reference) => resolve_reference(&reference, &mut out)?,
                Event::Comment(_) => {}
                Event::End(element) if end_name(&element) == expected => return Ok(out),
                Event::Eof => {
                    return Err(ParseError::Malformed(format!(
                        "missing </{expected}> closing tag"
                    )));
                }
                other => {
                    return Err(ParseError::Malformed(format!(
                        "unexpected token inside <{expected}>: {other:?}"
                    )));
                }
            }
        }
    }

    fn parse_response_params(&mut self) -> Result<Value, ParseError> {
        self.skip_ignorable();
        match self.peek().clone() {
            Event::End(element) if end_name(&element) == "params" => {
                self.pos += 1;
                Ok(Value::Nil)
            }
            Event::Start(element) if tag_name(&element) == "param" => {
                self.pos += 1;
                let value = self.parse_value(0)?;
                self.expect_end("param")?;
                self.expect_end("params")?;
                Ok(value)
            }
            _ => Err(ParseError::Malformed(
                "expected <param> inside <params>".to_string(),
            )),
        }
    }

    fn parse_value(&mut self, depth: usize) -> Result<Value, ParseError> {
        if depth > MAX_XML_DEPTH {
            return Err(ParseError::Malformed(
                "XML-RPC document nested too deeply".to_string(),
            ));
        }

        if self.expect_start("value")? {
            return Ok(Value::String(String::new()));
        }

        self.skip_ignorable();
        match self.peek().clone() {
            Event::End(element) if end_name(&element) == "value" => {
                self.pos += 1;
                Ok(Value::String(String::new()))
            }
            Event::Text(_) | Event::CData(_) | Event::GeneralRef(_) => {
                Ok(Value::String(self.read_text_until_close("value")?))
            }
            Event::Start(_) | Event::Empty(_) => {
                let (tag, empty) = self.open_element()?;
                let value = match tag.as_str() {
                    "string" => {
                        if empty {
                            Value::String(String::new())
                        } else {
                            Value::String(self.read_text_until_close(&tag)?)
                        }
                    }
                    "i4" | "int" | "i8" => {
                        let text = if empty {
                            String::new()
                        } else {
                            self.read_text_until_close(&tag)?
                        };
                        let parsed = text
                            .trim()
                            .parse::<i64>()
                            .map_err(|_| malformed(format!("invalid integer <{tag}>: {text}")))?;
                        Value::Int(parsed)
                    }
                    "boolean" => {
                        let text = if empty {
                            String::new()
                        } else {
                            self.read_text_until_close(&tag)?
                        };
                        match text.trim() {
                            "1" | "true" => Value::Bool(true),
                            "0" | "false" => Value::Bool(false),
                            other => {
                                return Err(malformed(format!("invalid boolean: {other}")));
                            }
                        }
                    }
                    "double" => {
                        let text = if empty {
                            String::new()
                        } else {
                            self.read_text_until_close(&tag)?
                        };
                        let parsed = text
                            .trim()
                            .parse::<f64>()
                            .map_err(|_| malformed(format!("invalid double: {text}")))?;
                        Value::Double(parsed)
                    }
                    "base64" => {
                        let text = if empty {
                            String::new()
                        } else {
                            self.read_text_until_close(&tag)?
                        };
                        let compact: String =
                            text.chars().filter(|ch| !ch.is_whitespace()).collect();
                        let bytes = BASE64
                            .decode(compact)
                            .map_err(|_| malformed("invalid base64 value".to_string()))?;
                        Value::Base64(bytes)
                    }
                    "nil" => {
                        if !empty {
                            self.expect_end("nil")?;
                        }
                        Value::Nil
                    }
                    "array" => self.parse_array(depth, empty)?,
                    "struct" => self.parse_struct(depth, empty)?,
                    _ => {
                        let text = if empty {
                            String::new()
                        } else {
                            self.read_text_until_close(&tag)?
                        };
                        Value::String(text)
                    }
                };

                self.expect_end("value")?;
                Ok(value)
            }
            _ => Err(ParseError::Malformed(
                "unexpected token inside <value>".to_string(),
            )),
        }
    }

    fn parse_array(&mut self, depth: usize, empty: bool) -> Result<Value, ParseError> {
        let mut items = Vec::new();
        if !empty {
            let data_empty = self.expect_start("data")?;
            if !data_empty {
                loop {
                    self.skip_ignorable();
                    match self.peek().clone() {
                        Event::End(element) if end_name(&element) == "data" => {
                            self.pos += 1;
                            break;
                        }
                        Event::Start(element) if tag_name(&element) == "value" => {
                            items.push(self.parse_value(depth + 1)?);
                        }
                        Event::Empty(element) if tag_name(&element) == "value" => {
                            items.push(self.parse_value(depth + 1)?);
                        }
                        _ => {
                            return Err(ParseError::Malformed(
                                "unexpected token inside <array><data>".to_string(),
                            ));
                        }
                    }
                }
            }
            self.expect_end("array")?;
        }
        Ok(Value::Array(items))
    }

    fn parse_struct(&mut self, depth: usize, empty: bool) -> Result<Value, ParseError> {
        let mut members = HashMap::new();
        if !empty {
            loop {
                self.skip_ignorable();
                match self.peek().clone() {
                    Event::End(element) if end_name(&element) == "struct" => {
                        self.pos += 1;
                        break;
                    }
                    Event::Start(element) if tag_name(&element) == "member" => {
                        self.pos += 1;
                    }
                    Event::Empty(element) if tag_name(&element) == "member" => {
                        self.pos += 1;
                        continue;
                    }
                    _ => {
                        return Err(ParseError::Malformed(
                            "unexpected token inside <struct>".to_string(),
                        ));
                    }
                }

                let name = if self.expect_start("name")? {
                    String::new()
                } else {
                    self.read_text_until_close("name")?
                };
                let value = self.parse_value(depth + 1)?;
                self.expect_end("member")?;
                members.insert(name, value);
            }
        }
        Ok(Value::Struct(members))
    }
}

fn tag_name(element: &BytesStart<'_>) -> String {
    String::from_utf8_lossy(element.local_name().as_ref()).into_owned()
}

fn end_name(element: &BytesEnd<'_>) -> String {
    String::from_utf8_lossy(element.local_name().as_ref()).into_owned()
}

fn resolve_reference(reference: &BytesRef<'_>, out: &mut String) -> Result<(), ParseError> {
    if let Some(ch) = reference
        .resolve_char_ref()
        .map_err(|error| malformed(format!("invalid character reference: {error}")))?
    {
        out.push(ch);
        return Ok(());
    }

    let name = reference
        .decode()
        .map_err(|error| malformed(format!("invalid entity encoding: {error}")))?;
    match quick_xml::escape::resolve_predefined_entity(&name) {
        Some(value) => {
            out.push_str(value);
            Ok(())
        }
        None => Err(malformed(format!("unknown XML entity &{name};"))),
    }
}

fn malformed(message: impl Into<String>) -> ParseError {
    ParseError::Malformed(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(value_xml: &str) -> String {
        format!(
            "<?xml version=\"1.0\"?><methodResponse><params><param><value>{value_xml}</value></param></params></methodResponse>"
        )
    }

    fn deep_response(levels: usize) -> String {
        let mut body = String::new();
        for _ in 0..levels {
            body.push_str("<value><array><data>");
        }
        body.push_str("<value><string>deep</string></value>");
        for _ in 0..levels {
            body.push_str("</data></array></value>");
        }
        format!("<methodResponse><params><param>{body}</param></params></methodResponse>")
    }

    #[test]
    fn encodes_all_value_kinds() {
        let mut members = HashMap::new();
        members.insert("name".to_string(), Value::String("A & B".to_string()));

        let params = vec![
            Value::String("A & B <3> \"q\" 'a'".to_string()),
            Value::Int(7),
            Value::Int(4_294_967_296),
            Value::Bool(true),
            Value::Bool(false),
            Value::Double(1.5),
            Value::Base64(b"hi".to_vec()),
            Value::Array(vec![Value::Int(1), Value::String("two".to_string())]),
            Value::Struct(members),
            Value::Nil,
        ];
        let xml = encode_call("demo.method", &params);

        assert!(xml.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"));
        assert!(xml.contains("<methodName>demo.method</methodName>"));
        assert!(xml.contains("<string>A &amp; B &lt;3&gt; &quot;q&quot; &apos;a&apos;</string>"));
        assert!(xml.contains("<i4>7</i4>"));
        assert!(xml.contains("<i8>4294967296</i8>"));
        assert!(xml.contains("<boolean>1</boolean>"));
        assert!(xml.contains("<boolean>0</boolean>"));
        assert!(xml.contains("<double>1.5</double>"));
        assert!(xml.contains("<base64>aGk=</base64>"));
        assert!(xml.contains("<nil/>"));
        assert!(xml.contains(
            "<member><name>name</name><value><string>A &amp; B</string></value></member>"
        ));
    }

    #[test]
    fn escapes_method_names() {
        let xml = encode_call("a&b<c", &[]);
        assert!(xml.contains("<methodName>a&amp;b&lt;c</methodName>"));
    }

    #[test]
    fn round_trips_calls() {
        let mut members = HashMap::new();
        members.insert("hash".to_string(), Value::String("abc".to_string()));
        members.insert("done".to_string(), Value::Bool(false));
        let params = vec![
            Value::String("first".to_string()),
            Value::Int(-42),
            Value::Double(0.25),
            Value::Array(vec![
                Value::Base64(vec![0, 1, 2, 255]),
                Value::Struct(members),
                Value::Nil,
            ]),
        ];

        let xml = encode_call("system.multicall", &params);
        let (method, parsed) = parse_call(&xml).unwrap();
        assert_eq!(method, "system.multicall");
        assert_eq!(parsed, params);
    }

    #[test]
    fn parses_bare_text_entities_cdata_and_prefixed_tags() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
            <!-- comment -->
            <methodResponse>
              <params>
                <param>
                  <value>
                    <array>
                      <data>
                        <value><string>A &amp; B &lt;3&gt; &#33; &#x3F;</string></value>
                        <value><ex:i8>4294967296</ex:i8></value>
                        <value>bare string</value>
                        <value><string><![CDATA[<raw> & data]]></string></value>
                        <value><string/></value>
                        <value/>
                        <value><boolean>1</boolean></value>
                        <value><ex:nil/></value>
                      </data>
                    </array>
                  </value>
                </param>
              </params>
            </methodResponse>"#;

        let parsed = parse_response(xml).unwrap();
        let items = parsed.as_array().unwrap();
        assert_eq!(items[0].as_str(), Some("A & B <3> ! ?"));
        assert_eq!(items[1].as_i64(), Some(4_294_967_296));
        assert_eq!(items[2].as_str(), Some("bare string"));
        assert_eq!(items[3].as_str(), Some("<raw> & data"));
        assert_eq!(items[4].as_str(), Some(""));
        assert_eq!(items[5].as_str(), Some(""));
        assert_eq!(items[6].as_i64(), Some(1));
        assert_eq!(items[7], Value::Nil);
    }

    #[test]
    fn parses_empty_tags() {
        assert_eq!(
            parse_response(&response("<array><data/></array>")).unwrap(),
            Value::Array(Vec::new())
        );
        assert_eq!(
            parse_response(&response("<array/>")).unwrap(),
            Value::Array(Vec::new())
        );
        assert_eq!(
            parse_response(&response("<struct/>")).unwrap(),
            Value::Struct(HashMap::new())
        );
        assert_eq!(parse_response(&response("<ex:nil/>")).unwrap(), Value::Nil);
        assert_eq!(
            parse_response("<methodResponse><params/></methodResponse>").unwrap(),
            Value::Nil
        );
        assert_eq!(
            parse_response(
                "<methodResponse><params><param><value/></param></params></methodResponse>"
            )
            .unwrap(),
            Value::String(String::new())
        );
        assert_eq!(
            parse_response("<methodResponse><params></params></methodResponse>").unwrap(),
            Value::Nil
        );
    }

    #[test]
    fn parses_nested_arrays_and_structs() {
        let xml = r#"<methodResponse><params><param><value><struct>
            <member><name>items</name><value><array><data>
              <value><struct>
                <member><name>id</name><value><i4>1</i4></value></member>
                <member><name>tags</name><value><array><data>
                  <value><string>a</string></value>
                  <value><string>b</string></value>
                </data></array></value></member>
              </struct></value>
            </data></array></value></member>
            <member><name>ok</name><value><boolean>1</boolean></value></member>
        </struct></value></param></params></methodResponse>"#;

        let parsed = parse_response(xml).unwrap();
        let Value::Struct(root) = parsed else {
            panic!("expected struct, got {parsed:?}");
        };
        assert_eq!(root.get("ok"), Some(&Value::Bool(true)));
        let items = root.get("items").and_then(Value::as_array).unwrap();
        let Value::Struct(item) = &items[0] else {
            panic!("expected nested struct, got {:?}", items[0]);
        };
        assert_eq!(item.get("id").and_then(Value::as_i64), Some(1));
        let tags = item.get("tags").and_then(Value::as_array).unwrap();
        assert_eq!(tags[0].as_str(), Some("a"));
        assert_eq!(tags[1].as_str(), Some("b"));
    }

    #[test]
    fn parses_and_encodes_faults() {
        let xml = r#"<methodResponse><fault><value><struct>
            <member><name>faultCode</name><value><i4>-501</i4></value></member>
            <member><name>faultString</name><value><string>Could not find info-hash.</string></value></member>
        </struct></value></fault></methodResponse>"#;
        assert_eq!(
            parse_response(xml),
            Err(ParseError::Fault {
                code: -501,
                message: "Could not find info-hash.".to_string(),
            })
        );

        let encoded = encode_fault(-501, "Could not find info-hash. & retry");
        assert_eq!(
            parse_response(&encoded),
            Err(ParseError::Fault {
                code: -501,
                message: "Could not find info-hash. & retry".to_string(),
            })
        );
    }

    #[test]
    fn round_trips_responses() {
        let mut members = HashMap::new();
        members.insert("name".to_string(), Value::String("A & B".to_string()));
        let value = Value::Array(vec![
            Value::String("A & B <3>".to_string()),
            Value::Int(9),
            Value::Bool(false),
            Value::Struct(members),
            Value::Nil,
        ]);

        let xml = encode_response(&value);
        assert_eq!(parse_response(&xml).unwrap(), value);
    }

    #[test]
    fn rejects_excessive_nesting() {
        assert!(parse_response(&deep_response(4)).is_ok());

        let error = parse_response(&deep_response(MAX_XML_DEPTH + 2)).unwrap_err();
        assert!(matches!(error, ParseError::Malformed(_)));
    }

    #[test]
    fn rejects_malformed_xml() {
        assert!(matches!(
            parse_response("not xml"),
            Err(ParseError::Malformed(_))
        ));
        assert!(matches!(
            parse_response(
                "<methodResponse><params><param><value><string>oops</value></param></params></methodResponse>"
            ),
            Err(ParseError::Malformed(_))
        ));
        assert!(matches!(
            parse_response(&response("<string>&bogus;</string>")),
            Err(ParseError::Malformed(_))
        ));
        assert!(matches!(
            parse_response(&response("<i4>not a number</i4>")),
            Err(ParseError::Malformed(_))
        ));
        assert!(matches!(
            parse_response("<methodResponse/>"),
            Err(ParseError::Malformed(_))
        ));
        assert!(matches!(
            parse_response("<methodResponse><unknown/></methodResponse>"),
            Err(ParseError::Malformed(_))
        ));
    }
}
