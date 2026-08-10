import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";

type ScoreDimension = { score: number; label: string };

type TraceraScore = {
  overall: number;
  factualAccuracy: ScoreDimension;
  sourceCorroboration: ScoreDimension;
  framingManipulation: ScoreDimension;
  evidenceQuality: ScoreDimension;
  sourceReputation?: ScoreDimension;
  recency: { flag: string; newestEvidenceAt: string | null };
};

type EvidenceSource = {
  id: string;
  title: string;
  publisher?: string;
  url?: string;
};

type ClaimResult = {
  claim: { id: string; claimText: string; checkability: string };
  verdict: string;
  confidence: number;
  reasoning: string[];
  evidenceQuality?: number;
  consideredSources?: EvidenceSource[];
  supportingSources?: EvidenceSource[];
  contradictingSources?: EvidenceSource[];
};

type Analysis = {
  check: { id: string; createdAt: string };
  claims: ClaimResult[];
  traceraScore: TraceraScore;
  cached: boolean;
  timeline?: TimelineEntry[];
  groundZero?: {
    confidence: string;
    earliestSource: EvidenceSource | null;
    signals: string[];
  };
};

type TimelineEntry = {
  id: string;
  tracera_score: TraceraScore;
  created_at: string;
};

type HubCheck = {
  id: string;
  rawInput: string;
  traceraScore: TraceraScore;
  createdAt: string;
};

type AuthUser = {
  id: string;
  email: string;
  createdAt: string;
};

type StoredCheck = HubCheck & {
  analysis: { claims: ClaimResult[]; score: TraceraScore };
};

const API_URL = "https://api.tracera.voltcrash.com";
const EXAMPLE =
  "A new study found that drinking coffee after 2pm doubles the risk of insomnia for all adults.";

async function mobileFetch(input: string, init: RequestInit = {}) {
  return fetch(input, init);
}

export default function App() {
  return <TraceraApp />;
}

function TraceraApp() {
  const [tab, setTab] = useState<"trace" | "hub">("trace");
  const [input, setInput] = useState("");
  const [image, setImage] = useState<{
    uri: string;
    base64: string;
    mimeType?: string;
  } | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isTracing, setIsTracing] = useState(false);
  const [hubChecks, setHubChecks] = useState<HubCheck[]>([]);
  const [isLoadingHub, setIsLoadingHub] = useState(false);
  const [hubAnalysis, setHubAnalysis] = useState<Analysis | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "signup" | null>(null);
  const [authUser] = useState<AuthUser | null>(null);

  const loadHub = useCallback(async () => {
    setIsLoadingHub(true);
    try {
      const response = await mobileFetch(`${API_URL}/checks?pageSize=20`);
      const payload = (await response.json()) as {
        checks?: HubCheck[];
        error?: string;
      };
      if (!response.ok)
        throw new Error(payload.error ?? "Could not load the News Hub.");
      setHubChecks(payload.checks ?? []);
    } catch (loadError) {
      setError(messageFrom(loadError));
    } finally {
      setIsLoadingHub(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "hub") void loadHub();
  }, [loadHub, tab]);

  async function openCheck(check: HubCheck) {
    setIsLoadingDetail(true);
    setError(null);
    try {
      const [response, timelineResponse] = await Promise.all([
        mobileFetch(`${API_URL}/checks/${check.id}`),
        mobileFetch(`${API_URL}/checks/${check.id}/timeline`),
      ]);
      const [payload, timelinePayload] = await Promise.all([
        response.json() as Promise<{ check?: StoredCheck; error?: string }>,
        timelineResponse.json() as Promise<{ timeline?: TimelineEntry[] }>,
      ]);
      if (!response.ok || !payload.check)
        throw new Error(payload.error ?? "Could not load this analysis.");
      setHubAnalysis({
        cached: true,
        check: { id: payload.check.id, createdAt: payload.check.createdAt },
        claims: payload.check.analysis.claims,
        traceraScore:
          payload.check.analysis.score ?? payload.check.traceraScore,
        timeline: timelineResponse.ok ? (timelinePayload.timeline ?? []) : [],
      });
    } catch (detailError) {
      setError(messageFrom(detailError));
    } finally {
      setIsLoadingDetail(false);
    }
  }

  async function signOut() {
    setAuthMode(null);
  }

  async function chooseImage() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        "Photo access needed",
        "Allow access to select a news image to check.",
      );
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      base64: true,
      quality: 0.65,
      selectionLimit: 1,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset?.base64) {
      setError(
        "That image could not be prepared for analysis. Please try another image.",
      );
      return;
    }
    setImage({
      uri: asset.uri,
      base64: asset.base64,
      mimeType: asset.mimeType ?? undefined,
    });
    setInput("");
    setError(null);
  }

  async function trace() {
    const value = input.trim();
    if (!value && !image) return;

    setIsTracing(true);
    setError(null);
    setAnalysis(null);
    try {
      const body = image
        ? {
            image: `data:${image.mimeType ?? "image/jpeg"};base64,${image.base64}`,
            imageMimeType: image.mimeType ?? "image/jpeg",
          }
        : isHttpUrl(value)
          ? { url: value }
          : { text: value };
      const response = await mobileFetch(`${API_URL}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as Analysis & { error?: string };
      if (!response.ok)
        throw new Error(payload.error ?? "Unable to analyze this item.");
      setAnalysis(payload);
      setImage(null);
    } catch (traceError) {
      setError(messageFrom(traceError));
    } finally {
      setIsTracing(false);
    }
  }

  function resetTrace() {
    setInput("");
    setImage(null);
    setAnalysis(null);
    setError(null);
  }

  if (authMode) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="dark-content" />
        <AuthScreen
          mode={authMode}
          onBack={() => setAuthMode(null)}
          onAuthenticated={() => setAuthMode(null)}
          onModeChange={setAuthMode}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      <KeyboardAvoidingView
        behavior={Platform.select({ ios: "padding", default: undefined })}
        style={styles.app}
      >
        <View style={styles.header}>
          <View style={styles.brandRow}>
            <Image
              accessibilityLabel="Tracera"
              resizeMode="contain"
              source={require("../web/public/brand/tracera-wordmark-cropped.png")}
              style={styles.wordmarkLogo}
            />
          </View>
          <View style={styles.headerActions}>
            <Pressable onPress={() => setTab("hub")} hitSlop={8}>
              <Text style={styles.hubLink}>News Hub</Text>
            </Pressable>
            <Pressable
              onPress={
                authUser ? () => void signOut() : () => setAuthMode("login")
              }
              hitSlop={8}
            >
              <Text style={styles.authLink}>
                {authUser ? "Log out" : "Log in"}
              </Text>
            </Pressable>
          </View>
        </View>

        {tab === "trace" ? (
          <TraceScreen
            analysis={analysis}
            error={error}
            image={image}
            input={input}
            isTracing={isTracing}
            onChooseImage={() => void chooseImage()}
            alertEmail={authUser?.email}
            onInputChange={setInput}
            onReset={resetTrace}
            onTrace={() => void trace()}
          />
        ) : (
          <HubScreen
            checks={hubChecks}
            error={error}
            isLoading={isLoadingHub}
            isLoadingDetail={isLoadingDetail}
            selectedAnalysis={hubAnalysis}
            alertEmail={authUser?.email}
            onBack={() => setTab("trace")}
            onRefresh={() => void loadHub()}
            onSelect={(check) => void openCheck(check)}
            onCloseDetail={() => setHubAnalysis(null)}
            onNewTrace={() => {
              setHubAnalysis(null);
              setTab("trace");
              resetTrace();
            }}
          />
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function TraceScreen({
  analysis,
  error,
  image,
  input,
  isTracing,
  onChooseImage,
  alertEmail,
  onInputChange,
  onReset,
  onTrace,
}: {
  analysis: Analysis | null;
  error: string | null;
  image: { uri: string } | null;
  input: string;
  isTracing: boolean;
  onChooseImage: () => void;
  alertEmail?: string;
  onInputChange: (value: string) => void;
  onReset: () => void;
  onTrace: () => void;
}) {
  if (analysis)
    return (
      <ResultScreen
        analysis={analysis}
        alertEmail={alertEmail}
        onNewTrace={onReset}
      />
    );

  return (
    <ScrollView
      contentContainerStyle={styles.traceScroll}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>START A TRACE</Text>
        <Text style={styles.heroTitle}>What would you like to check?</Text>
        <Text style={styles.heroCopy}>
          Paste a claim, headline, article, or link. We’ll trace it back to the
          evidence.
        </Text>
      </View>

      <View style={styles.composer}>
        {image ? (
          <View style={styles.imagePreview}>
            <Image source={{ uri: image.uri }} style={styles.selectedImage} />
            <Text style={styles.imageCaption}>Image ready to trace</Text>
            <Pressable onPress={onReset} style={styles.clearImage}>
              <Text style={styles.clearImageText}>Remove</Text>
            </Pressable>
          </View>
        ) : (
          <TextInput
            accessibilityLabel="Story, claim, or link to analyze"
            editable={!isTracing}
            multiline
            onChangeText={onInputChange}
            placeholder="Paste a story, claim, or link…"
            placeholderTextColor={COLORS.muted}
            style={styles.input}
            textAlignVertical="top"
            value={input}
          />
        )}
        <View style={styles.composerFooter}>
          <Pressable
            disabled={isTracing}
            onPress={onChooseImage}
            style={styles.photoButton}
          >
            <Text style={styles.photoButtonText}>＋ Image</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={isTracing || (!input.trim() && !image)}
            onPress={onTrace}
            style={({ pressed }) => [
              styles.traceButton,
              ((!input.trim() && !image) || isTracing) &&
                styles.traceButtonDisabled,
              pressed && styles.pressed,
            ]}
          >
            {isTracing ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.traceButtonText}>Analyze →</Text>
            )}
          </Pressable>
        </View>
      </View>

      <View style={styles.exampleRow}>
        <Text style={styles.helpText}>Links are detected automatically.</Text>
        <Pressable disabled={isTracing} onPress={() => onInputChange(EXAMPLE)}>
          <Text style={styles.exampleButton}>Try an example</Text>
        </Pressable>
      </View>

      {isTracing ? <LoadingNotice /> : null}
      {error ? <ErrorNotice message={error} /> : null}
      <Text style={styles.privacyText}>
        Evidence over virality. Your check is stored to improve future traces.
      </Text>
    </ScrollView>
  );
}

function ResultScreen({
  analysis,
  onNewTrace,
  onBack,
  alertEmail,
}: {
  analysis: Analysis;
  onNewTrace: () => void;
  onBack?: () => void;
  alertEmail?: string;
}) {
  const score = analysis.traceraScore;
  return (
    <ScrollView contentContainerStyle={styles.resultScroll}>
      {onBack ? (
        <Pressable onPress={onBack} style={styles.resultBackButton}>
          <Text style={styles.backText}>← Back to News Hub</Text>
        </Pressable>
      ) : null}
      <View style={styles.resultTopline}>
        <View style={styles.completeDot} />
        <Text style={styles.completeText}>
          Analysis complete{analysis.cached ? " · recent matching check" : ""}
        </Text>
      </View>
      <View style={styles.scoreCard}>
        <Text style={styles.scoreEyebrow}>TRACERA SCORE</Text>
        <Text style={styles.scoreValue}>
          {score.overall}
          <Text style={styles.scoreOutOf}>/100</Text>
        </Text>
        <Text style={styles.scoreSummary}>
          {scoreLabel(score.overall)} signal from the available evidence.
        </Text>
        <View style={styles.scoreDivider} />
        <ScoreRow label="Factual accuracy" value={score.factualAccuracy} />
        <ScoreRow
          label="Source corroboration"
          value={score.sourceCorroboration}
        />
        <ScoreRow
          label="Framing & language"
          value={score.framingManipulation}
        />
        <ScoreRow label="Evidence quality" value={score.evidenceQuality} />
        <View style={styles.recencyPill}>
          <Text style={styles.recencyText}>
            Evidence recency: {score.recency.flag}
          </Text>
        </View>
      </View>

      <View style={styles.claimHeader}>
        <Text style={styles.eyebrow}>
          CLAIM MAP · {analysis.claims.length} SIGNALS
        </Text>
        <Text style={styles.claimHeading}>Story, separated from spin.</Text>
      </View>
      {analysis.claims.map((claim, index) => (
        <ClaimCard claim={claim} index={index} key={claim.claim.id || index} />
      ))}

      {analysis.groundZero?.earliestSource ? (
        <View style={styles.groundZeroCard}>
          <Text style={styles.sourcesEyebrow}>
            GROUND ZERO · {analysis.groundZero.confidence} confidence
          </Text>
          <Text style={styles.groundZeroTitle}>
            {analysis.groundZero.earliestSource.title}
          </Text>
          {analysis.groundZero.signals.slice(0, 2).map((signal) => (
            <Text key={signal} style={styles.groundZeroText}>
              • {signal}
            </Text>
          ))}
        </View>
      ) : null}

      <MobileTimeline
        entries={
          analysis.timeline ?? [
            {
              id: analysis.check.id,
              tracera_score: score,
              created_at: analysis.check.createdAt,
            },
          ]
        }
      />
      <MobileAlertSubscription
        checkId={analysis.check.id}
        defaultEmail={alertEmail}
      />

      <Pressable onPress={onNewTrace} style={styles.newTraceButton}>
        <Text style={styles.newTraceText}>Start another trace</Text>
      </Pressable>
    </ScrollView>
  );
}

function ScoreRow({ label, value }: { label: string; value: ScoreDimension }) {
  return (
    <View style={styles.scoreRow}>
      <Text style={styles.scoreRowLabel}>{label}</Text>
      <Text style={styles.scoreRowValue}>
        {value.score} · {value.label}
      </Text>
    </View>
  );
}

function ClaimCard({ claim, index }: { claim: ClaimResult; index: number }) {
  const sources = uniqueSources([
    ...(claim.supportingSources ?? []),
    ...(claim.contradictingSources ?? []),
    ...(claim.consideredSources ?? []),
  ]).slice(0, 3);
  return (
    <View style={styles.claimCard}>
      <View style={styles.claimTopline}>
        <Text style={styles.claimNumber}>CLAIM {index + 1}</Text>
        <View style={[styles.verdict, verdictStyle(claim.verdict)]}>
          <Text style={[styles.verdictText, verdictTextStyle(claim.verdict)]}>
            {claim.verdict}
          </Text>
        </View>
      </View>
      <Text style={styles.claimText}>{claim.claim.claimText}</Text>
      <View style={styles.chipRow}>
        <InfoChip label={`${Math.round(claim.confidence * 100)}% confidence`} />
        {typeof claim.evidenceQuality === "number" ? (
          <InfoChip
            label={`${Math.round(claim.evidenceQuality * 100)}% evidence`}
          />
        ) : null}
      </View>
      {claim.reasoning.slice(0, 3).map((reason, reasonIndex) => (
        <View key={reasonIndex} style={styles.reasonRow}>
          <View style={styles.reasonDot} />
          <Text style={styles.reasonText}>{reason}</Text>
        </View>
      ))}
      {sources.length > 0 ? (
        <View style={styles.sourceBlock}>
          <Text style={styles.sourcesEyebrow}>EVIDENCE SOURCES</Text>
          {sources.map((source) => (
            <Pressable
              key={source.id}
              onPress={() => source.url && void Linking.openURL(source.url)}
              style={styles.sourceLink}
            >
              <Text numberOfLines={1} style={styles.sourceTitle}>
                {source.title}
              </Text>
              {source.publisher ? (
                <Text numberOfLines={1} style={styles.sourcePublisher}>
                  {source.publisher}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function MobileTimeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <View style={styles.timelineCard}>
      <Text style={styles.sourcesEyebrow}>TRACE TIMELINE</Text>
      <Text style={styles.timelineTitle}>How this trace changed</Text>
      {entries.map((entry, index) => {
        const previous = entries[index - 1];
        const delta = previous
          ? Math.round(
              entry.tracera_score.overall - previous.tracera_score.overall,
            )
          : null;
        return (
          <View key={entry.id} style={styles.timelineRow}>
            <View style={styles.timelineDot} />
            <View style={styles.timelineCopy}>
              <Text style={styles.timelineLabel}>
                {index === 0 ? "First checked" : "Evidence rechecked"}
              </Text>
              <Text style={styles.timelineDate}>
                {formatDate(entry.created_at)}
              </Text>
              <Text style={styles.timelineScore}>
                Score {entry.tracera_score.overall}/100
                {delta === null
                  ? ""
                  : delta === 0
                    ? " · unchanged"
                    : ` · ${delta > 0 ? "+" : ""}${delta} points`}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

function MobileAlertSubscription({
  checkId,
  defaultEmail,
}: {
  checkId: string;
  defaultEmail?: string;
}) {
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [status, setStatus] = useState<string | null>(null);
  async function subscribe() {
    if (!email.trim()) return;
    try {
      const response = await mobileFetch(
        `${API_URL}/checks/${checkId}/alerts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim() }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      setStatus(
        response.ok
          ? "You’ll get an email if this trace materially changes."
          : (payload.error ?? "Could not save this alert."),
      );
    } catch (error) {
      setStatus(messageFrom(error));
    }
  }
  return (
    <View style={styles.mobileAlertCard}>
      <Text style={styles.mobileAlertTitle}>Follow this trace</Text>
      <Text style={styles.mobileAlertCopy}>
        Get an email when fresh evidence materially changes its score.
      </Text>
      <TextInput
        autoCapitalize="none"
        keyboardType="email-address"
        onChangeText={setEmail}
        placeholder="you@example.com"
        placeholderTextColor="#9BB6AB"
        style={styles.mobileAlertInput}
        value={email}
      />
      <Pressable
        onPress={() => void subscribe()}
        style={styles.mobileAlertButton}
      >
        <Text style={styles.mobileAlertButtonText}>Notify me</Text>
      </Pressable>
      {status ? <Text style={styles.mobileAlertStatus}>{status}</Text> : null}
    </View>
  );
}

function InfoChip({ label }: { label: string }) {
  return (
    <View style={styles.infoChip}>
      <Text style={styles.infoChipText}>{label}</Text>
    </View>
  );
}

function HubScreen({
  checks,
  error,
  isLoading,
  isLoadingDetail,
  selectedAnalysis,
  alertEmail,
  onBack,
  onRefresh,
  onSelect,
  onCloseDetail,
  onNewTrace,
}: {
  checks: HubCheck[];
  error: string | null;
  isLoading: boolean;
  isLoadingDetail: boolean;
  selectedAnalysis: Analysis | null;
  alertEmail?: string;
  onBack: () => void;
  onRefresh: () => void;
  onSelect: (check: HubCheck) => void;
  onCloseDetail: () => void;
  onNewTrace: () => void;
}) {
  if (selectedAnalysis)
    return (
      <ResultScreen
        analysis={selectedAnalysis}
        alertEmail={alertEmail}
        onBack={onCloseDetail}
        onNewTrace={onNewTrace}
      />
    );
  return (
    <ScrollView contentContainerStyle={styles.hubScroll}>
      <Pressable onPress={onBack} style={styles.backButton}>
        <Text style={styles.backText}>← Back to trace</Text>
      </Pressable>
      <Text style={styles.eyebrow}>NEWS HUB</Text>
      <Text style={styles.hubTitle}>Recently traced</Text>
      <Text style={styles.hubCopy}>
        Revisit community checks while their evidence is still current.
      </Text>
      {isLoading || isLoadingDetail ? (
        <View style={styles.hubLoading}>
          <ActivityIndicator color={COLORS.green} />
        </View>
      ) : null}
      {error ? <ErrorNotice message={error} /> : null}
      {!isLoading && !error && checks.length === 0 ? (
        <View style={styles.emptyHub}>
          <Text style={styles.emptyHubTitle}>No checks yet</Text>
          <Text style={styles.emptyHubCopy}>
            The first completed trace will appear here.
          </Text>
        </View>
      ) : null}
      {checks.map((check) => (
        <HubCard check={check} key={check.id} onPress={() => onSelect(check)} />
      ))}
      <Pressable onPress={onRefresh} style={styles.refreshButton}>
        <Text style={styles.refreshText}>Refresh News Hub</Text>
      </Pressable>
    </ScrollView>
  );
}

function HubCard({ check, onPress }: { check: HubCheck; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open analysis checked ${formatDate(check.createdAt)}`}
      onPress={onPress}
      style={({ pressed }) => [styles.hubCard, pressed && styles.pressed]}
    >
      <View style={styles.hubCardTop}>
        <Text style={styles.hubDate}>{formatDate(check.createdAt)}</Text>
        <Text style={styles.hubScore}>{check.traceraScore.overall}/100</Text>
      </View>
      <Text numberOfLines={3} style={styles.hubInput}>
        {check.rawInput}
      </Text>
      <Text style={styles.hubEvidence}>
        Evidence: {check.traceraScore.recency.flag}
      </Text>
      <Text style={styles.hubOpen}>Open full analysis →</Text>
    </Pressable>
  );
}

function AuthScreen({
  mode,
  onBack,
  onModeChange,
}: {
  mode: "login" | "signup";
  onBack: () => void;
  onAuthenticated: () => void;
  onModeChange: (mode: "login" | "signup") => void;
}) {
  const signingUp = mode === "signup";

  return (
    <KeyboardAvoidingView
      behavior={Platform.select({ ios: "padding", default: undefined })}
      style={styles.authScreen}
    >
      <ScrollView
        contentContainerStyle={styles.authScroll}
        keyboardShouldPersistTaps="handled"
      >
        <Pressable onPress={onBack} style={styles.authBack}>
          <Text style={styles.backText}>← Back to Tracera</Text>
        </Pressable>
        <Image
          resizeMode="contain"
          source={require("../web/public/brand/tracera-wordmark-cropped.png")}
          style={styles.authLogo}
        />
        <Text style={styles.eyebrow}>YOUR TRACERA ACCOUNT</Text>
        <Text style={styles.authTitle}>
          {signingUp ? "Account creation is paused" : "Sign-in is paused"}
        </Text>
        <Text style={styles.authCopy}>
          Account access is temporarily unavailable while authentication is
          upgraded.
        </Text>
        <Pressable
          onPress={() => onModeChange(signingUp ? "login" : "signup")}
          style={styles.authSubmit}
        >
          <Text style={styles.authSubmitText}>
            {signingUp ? "View sign-in" : "View account creation"}
          </Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function LoadingNotice() {
  return (
    <View style={styles.loadingNotice}>
      <ActivityIndicator color={COLORS.green} />
      <View style={styles.noticeCopy}>
        <Text style={styles.noticeTitle}>
          Tracing sources and checking claims
        </Text>
        <Text style={styles.noticeText}>
          We’re separating evidence from assertion.
        </Text>
      </View>
    </View>
  );
}

function ErrorNotice({ message }: { message: string }) {
  const connectionHint = message
    .toLowerCase()
    .includes("network request failed")
    ? ` Check your connection to the Tracera API (${API_URL}).`
    : "";
  return (
    <View style={styles.errorNotice}>
      <Text style={styles.errorTitle}>Couldn’t complete that trace</Text>
      <Text style={styles.errorText}>
        {message}
        {connectionHint}
      </Text>
    </View>
  );
}

function isHttpUrl(value: string) {
  return /^https?:\/\/\S+$/i.test(value);
}

function uniqueSources(sources: EvidenceSource[]) {
  return sources.filter(
    (source, index) =>
      sources.findIndex((item) => item.id === source.id) === index,
  );
}

function verdictStyle(verdict: string) {
  return (
    {
      supported: styles.supported,
      contradicted: styles.contradicted,
      misleading: styles.misleading,
      mixed: styles.mixed,
    }[verdict] ?? styles.unverified
  );
}

function verdictTextStyle(verdict: string) {
  return (
    {
      supported: styles.supportedText,
      contradicted: styles.contradictedText,
      misleading: styles.misleadingText,
      mixed: styles.mixedText,
    }[verdict] ?? styles.unverifiedText
  );
}

function scoreLabel(score: number) {
  if (score >= 80) return "Strong";
  if (score >= 55) return "Mixed";
  return "Weak";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function messageFrom(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}

const COLORS = {
  ink: "#10221F",
  green: "#087A5A",
  pale: "#F4F6F2",
  mint: "#DDF8EC",
  muted: "#8B9B96",
  border: "#DDE5E0",
};

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.pale },
  app: { flex: 1 },
  header: {
    height: 72,
    paddingHorizontal: 20,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "#E5EBE7",
    backgroundColor: "rgba(244,246,242,0.97)",
  },
  brandRow: { flexDirection: "row", alignItems: "center" },
  wordmarkLogo: { width: 118, height: 30 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 13 },
  hubLink: { color: COLORS.green, fontSize: 13, fontWeight: "800" },
  authLink: { color: COLORS.ink, fontSize: 13, fontWeight: "800" },
  traceScroll: { flexGrow: 1, padding: 20, paddingTop: 56, paddingBottom: 34 },
  hero: { alignItems: "center" },
  eyebrow: {
    color: COLORS.green,
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 1.8,
  },
  heroTitle: {
    marginTop: 15,
    color: COLORS.ink,
    fontSize: 36,
    fontWeight: "900",
    lineHeight: 39,
    letterSpacing: -1.8,
    textAlign: "center",
  },
  heroCopy: {
    maxWidth: 340,
    marginTop: 15,
    color: "#597069",
    fontSize: 16,
    lineHeight: 24,
    textAlign: "center",
  },
  composer: {
    marginTop: 34,
    borderWidth: 1,
    borderColor: "#D8E2DC",
    borderRadius: 26,
    backgroundColor: "#fff",
    padding: 10,
    shadowColor: "#0B3125",
    shadowOffset: { width: 0, height: 13 },
    shadowOpacity: 0.08,
    shadowRadius: 22,
    elevation: 3,
  },
  input: {
    minHeight: 170,
    padding: 15,
    borderRadius: 19,
    color: COLORS.ink,
    backgroundColor: "#F8FAF7",
    fontSize: 16,
    lineHeight: 24,
  },
  composerFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 11,
    paddingHorizontal: 4,
  },
  photoButton: { paddingHorizontal: 9, paddingVertical: 10 },
  photoButtonText: { color: COLORS.green, fontSize: 14, fontWeight: "800" },
  traceButton: {
    minWidth: 114,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 13,
    backgroundColor: COLORS.ink,
    paddingHorizontal: 16,
    paddingVertical: 13,
    shadowColor: "#71DABD",
    shadowOffset: { width: 3, height: 3 },
    shadowOpacity: 1,
    shadowRadius: 0,
    elevation: 2,
  },
  traceButtonDisabled: { backgroundColor: "#AAB7B2", shadowOpacity: 0 },
  traceButtonText: { color: "#fff", fontSize: 14, fontWeight: "900" },
  pressed: { opacity: 0.85 },
  exampleRow: {
    marginTop: 15,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  helpText: { color: "#83928D", fontSize: 12 },
  exampleButton: { color: COLORS.green, fontSize: 13, fontWeight: "800" },
  privacyText: {
    marginTop: "auto",
    paddingTop: 38,
    color: "#8B9994",
    fontSize: 11,
    lineHeight: 16,
    textAlign: "center",
  },
  imagePreview: {
    minHeight: 170,
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRadius: 19,
    backgroundColor: "#E8F0EB",
  },
  selectedImage: { width: "100%", height: 210 },
  imageCaption: {
    position: "absolute",
    left: 12,
    bottom: 12,
    borderRadius: 10,
    overflow: "hidden",
    paddingHorizontal: 10,
    paddingVertical: 7,
    color: "#fff",
    backgroundColor: "rgba(16,34,31,0.8)",
    fontSize: 12,
    fontWeight: "800",
  },
  clearImage: {
    position: "absolute",
    top: 11,
    right: 11,
    borderRadius: 9,
    backgroundColor: "rgba(255,255,255,0.95)",
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  clearImageText: { color: COLORS.ink, fontSize: 12, fontWeight: "800" },
  loadingNotice: {
    marginTop: 20,
    flexDirection: "row",
    gap: 12,
    borderWidth: 1,
    borderColor: "#BFEAD7",
    borderRadius: 16,
    backgroundColor: "#EAF9F1",
    padding: 15,
  },
  noticeCopy: { flex: 1 },
  noticeTitle: { color: COLORS.ink, fontSize: 14, fontWeight: "800" },
  noticeText: { marginTop: 3, color: "#4D6A61", fontSize: 13 },
  errorNotice: {
    marginTop: 20,
    borderWidth: 1,
    borderColor: "#F5C9C6",
    borderRadius: 16,
    backgroundColor: "#FFF3F2",
    padding: 15,
  },
  errorTitle: { color: "#9C302B", fontSize: 14, fontWeight: "900" },
  errorText: { marginTop: 5, color: "#9C302B", fontSize: 13, lineHeight: 19 },
  resultScroll: { padding: 20, paddingBottom: 36 },
  resultBackButton: {
    alignSelf: "flex-start",
    marginTop: 10,
    marginBottom: 13,
  },
  resultTopline: {
    marginTop: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  completeDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: "#21B780",
  },
  completeText: { color: COLORS.green, fontSize: 13, fontWeight: "800" },
  scoreCard: {
    marginTop: 15,
    overflow: "hidden",
    borderRadius: 25,
    backgroundColor: COLORS.ink,
    padding: 22,
  },
  scoreEyebrow: {
    color: "#9CF0D1",
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 1.8,
  },
  scoreValue: {
    marginTop: 8,
    color: "#fff",
    fontSize: 58,
    fontWeight: "900",
    letterSpacing: -3,
  },
  scoreOutOf: { fontSize: 20, letterSpacing: -1 },
  scoreSummary: { marginTop: 3, color: "#B8CDC5", fontSize: 14 },
  scoreDivider: {
    height: 1,
    marginTop: 20,
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  scoreRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 14,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.1)",
    paddingVertical: 10,
  },
  scoreRowLabel: { flex: 1, color: "#B8CDC5", fontSize: 13 },
  scoreRowValue: { color: "#fff", fontSize: 13, fontWeight: "800" },
  recencyPill: {
    marginTop: 16,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(255,255,255,0.08)",
    padding: 12,
  },
  recencyText: {
    color: "#D5E8E0",
    fontSize: 13,
    fontWeight: "700",
    textTransform: "capitalize",
  },
  claimHeader: { marginTop: 31, marginBottom: 12 },
  claimHeading: {
    marginTop: 5,
    color: COLORS.ink,
    fontSize: 24,
    fontWeight: "900",
    letterSpacing: -0.8,
  },
  claimCard: {
    marginTop: 11,
    borderWidth: 1,
    borderColor: "#DDE6E0",
    borderRadius: 20,
    backgroundColor: "#fff",
    padding: 17,
  },
  claimTopline: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  claimNumber: {
    color: "#71847C",
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 1.3,
  },
  verdict: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  verdictText: {
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  supported: { backgroundColor: "#DDF7EA" },
  supportedText: { color: "#087A5A" },
  contradicted: { backgroundColor: "#FFE4E1" },
  contradictedText: { color: "#B4322C" },
  misleading: { backgroundColor: "#FFF1CB" },
  misleadingText: { color: "#A96B00" },
  mixed: { backgroundColor: "#EEE8FF" },
  mixedText: { color: "#6346AA" },
  unverified: { backgroundColor: "#EDF0EF" },
  unverifiedText: { color: "#596863" },
  claimText: {
    marginTop: 13,
    color: COLORS.ink,
    fontSize: 16,
    fontWeight: "800",
    lineHeight: 23,
  },
  chipRow: { marginTop: 12, flexDirection: "row", flexWrap: "wrap", gap: 7 },
  infoChip: {
    borderRadius: 999,
    backgroundColor: "#EEF4F0",
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  infoChipText: { color: "#536A61", fontSize: 11, fontWeight: "800" },
  reasonRow: { marginTop: 11, flexDirection: "row", gap: 9 },
  reasonDot: {
    width: 5,
    height: 5,
    marginTop: 7,
    borderRadius: 5,
    backgroundColor: "#20A874",
  },
  reasonText: { flex: 1, color: "#51675F", fontSize: 13, lineHeight: 19 },
  sourceBlock: {
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: "#E7ECE9",
    paddingTop: 13,
  },
  sourcesEyebrow: {
    color: "#7A8D85",
    fontSize: 9,
    fontWeight: "900",
    letterSpacing: 1.3,
  },
  sourceLink: {
    marginTop: 8,
    borderRadius: 10,
    backgroundColor: "#F0F8F3",
    padding: 10,
  },
  sourceTitle: { color: "#145C46", fontSize: 13, fontWeight: "800" },
  sourcePublisher: { marginTop: 2, color: "#73837D", fontSize: 11 },
  newTraceButton: {
    alignItems: "center",
    marginTop: 27,
    borderRadius: 14,
    backgroundColor: "#D9F3E6",
    padding: 15,
  },
  newTraceText: { color: "#07533D", fontSize: 14, fontWeight: "900" },
  timelineCard: {
    marginTop: 24,
    borderWidth: 1,
    borderColor: "#DDE6E0",
    borderRadius: 20,
    backgroundColor: "#fff",
    padding: 17,
  },
  timelineTitle: {
    marginTop: 5,
    color: COLORS.ink,
    fontSize: 20,
    fontWeight: "900",
    letterSpacing: -0.6,
  },
  timelineRow: { position: "relative", flexDirection: "row", marginTop: 18 },
  timelineDot: {
    width: 10,
    height: 10,
    borderRadius: 10,
    marginTop: 4,
    marginRight: 12,
    backgroundColor: "#20A874",
  },
  timelineCopy: {
    flex: 1,
    borderLeftWidth: 2,
    borderLeftColor: "#D9F3E6",
    marginLeft: -17,
    paddingLeft: 20,
    paddingBottom: 4,
  },
  timelineLabel: { color: COLORS.ink, fontSize: 13, fontWeight: "900" },
  timelineDate: { marginTop: 2, color: "#798B84", fontSize: 11 },
  timelineScore: {
    marginTop: 5,
    color: "#496158",
    fontSize: 13,
    lineHeight: 19,
  },
  mobileAlertCard: {
    marginTop: 16,
    borderRadius: 20,
    backgroundColor: COLORS.ink,
    padding: 17,
  },
  mobileAlertTitle: { color: "#fff", fontSize: 16, fontWeight: "900" },
  mobileAlertCopy: {
    marginTop: 4,
    color: "#B8CDC5",
    fontSize: 13,
    lineHeight: 19,
  },
  mobileAlertInput: {
    marginTop: 14,
    borderRadius: 11,
    backgroundColor: "#fff",
    color: COLORS.ink,
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  mobileAlertButton: {
    alignItems: "center",
    marginTop: 9,
    borderRadius: 11,
    backgroundColor: "#9CF0D1",
    paddingVertical: 11,
  },
  mobileAlertButtonText: { color: COLORS.ink, fontSize: 13, fontWeight: "900" },
  mobileAlertStatus: {
    marginTop: 10,
    color: "#D5E8E0",
    fontSize: 12,
    lineHeight: 17,
  },
  groundZeroCard: {
    marginTop: 18,
    borderWidth: 1,
    borderColor: "#BFEAD7",
    borderRadius: 20,
    backgroundColor: "#EAF9F1",
    padding: 17,
  },
  groundZeroTitle: {
    marginTop: 6,
    color: COLORS.ink,
    fontSize: 16,
    fontWeight: "900",
    lineHeight: 22,
  },
  groundZeroText: {
    marginTop: 6,
    color: "#496158",
    fontSize: 12,
    lineHeight: 18,
  },
  hubScroll: { padding: 20, paddingBottom: 36 },
  backButton: { alignSelf: "flex-start", marginTop: 10, marginBottom: 35 },
  backText: { color: COLORS.green, fontSize: 14, fontWeight: "800" },
  hubTitle: {
    marginTop: 7,
    color: COLORS.ink,
    fontSize: 35,
    fontWeight: "900",
    letterSpacing: -1.6,
  },
  hubCopy: { marginTop: 10, color: "#597069", fontSize: 16, lineHeight: 24 },
  hubLoading: { marginTop: 28 },
  emptyHub: {
    marginTop: 26,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#DDE6E0",
    borderRadius: 20,
    backgroundColor: "#fff",
    padding: 25,
  },
  emptyHubTitle: { color: COLORS.ink, fontSize: 16, fontWeight: "900" },
  emptyHubCopy: { marginTop: 6, color: "#6F817A", fontSize: 13 },
  hubCard: {
    marginTop: 13,
    borderWidth: 1,
    borderColor: "#DDE6E0",
    borderRadius: 18,
    backgroundColor: "#fff",
    padding: 16,
  },
  hubCardTop: { flexDirection: "row", justifyContent: "space-between" },
  hubDate: { color: "#798B84", fontSize: 11, fontWeight: "800" },
  hubScore: { color: COLORS.green, fontSize: 13, fontWeight: "900" },
  hubInput: {
    marginTop: 10,
    color: COLORS.ink,
    fontSize: 15,
    fontWeight: "800",
    lineHeight: 21,
  },
  hubEvidence: {
    marginTop: 10,
    color: "#6F817A",
    fontSize: 12,
    textTransform: "capitalize",
  },
  hubOpen: {
    marginTop: 14,
    color: COLORS.green,
    fontSize: 12,
    fontWeight: "900",
  },
  refreshButton: { alignItems: "center", marginTop: 22, padding: 13 },
  refreshText: { color: COLORS.green, fontSize: 14, fontWeight: "900" },
  authScreen: { flex: 1 },
  authScroll: { flexGrow: 1, padding: 24, paddingTop: 26, paddingBottom: 48 },
  authBack: { alignSelf: "flex-start", marginBottom: 46 },
  authLogo: {
    alignSelf: "flex-start",
    width: 158,
    height: 37,
    marginBottom: 58,
  },
  authTitle: {
    marginTop: 12,
    color: COLORS.ink,
    fontSize: 34,
    fontWeight: "900",
    letterSpacing: -1.4,
  },
  authCopy: { marginTop: 9, color: "#597069", fontSize: 16, lineHeight: 24 },
  authForm: { marginTop: 32 },
  authLabel: {
    marginTop: 15,
    color: "#3D554C",
    fontSize: 13,
    fontWeight: "800",
  },
  authInput: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: "#D8E2DC",
    borderRadius: 14,
    backgroundColor: "#fff",
    color: COLORS.ink,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  authSubmit: {
    alignItems: "center",
    justifyContent: "center",
    marginTop: 25,
    borderRadius: 14,
    backgroundColor: COLORS.ink,
    paddingVertical: 15,
  },
  authSubmitText: { color: "#fff", fontSize: 15, fontWeight: "900" },
  authSwitch: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 5,
    marginTop: 26,
  },
  authSwitchText: { color: "#6F817A", fontSize: 13 },
  authSwitchLink: { color: COLORS.green, fontSize: 13, fontWeight: "900" },
});
