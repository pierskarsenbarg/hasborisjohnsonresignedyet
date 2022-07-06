import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as fs from "fs";
import * as mime from "mime";
import * as path from "path";

const website: string = "hasborisjohnsonresignedyet.com";

const crawlDirectory = function (dir: string, f: (_: string) => void) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const filePath = `${dir}/${file}`;
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            crawlDirectory(filePath, f);
        }
        if (stat.isFile()) {
            f(filePath);
        }
    }
}

const borisBucket = new aws.s3.Bucket("borisBucket", {
    acl: "public-read",
    bucket: website,
    website: {
        indexDocument: "index.html",
    },
});

const redirectBucket = new aws.s3.Bucket("redorectbucket", {
    acl: "public-read",
    website: {
        redirectAllRequestsTo: "https://hasborisjohnsonresignedyet.com/"
    }
})

const wwwDir = path.join(process.cwd(), "www");

crawlDirectory(
    wwwDir,
    (filePath: string) => {
        const relativeFilePath = filePath.replace(wwwDir + "/", "");
        new aws.s3.BucketObject(
            relativeFilePath,
            {
                key: relativeFilePath,
                acl: "public-read",
                bucket: borisBucket,
                contentType: mime.getType(filePath) || undefined,
                source: new pulumi.asset.FileAsset(filePath),
            },
            {
                parent: borisBucket,
            });
    });

const logsBucket = new aws.s3.Bucket("boriswebsiteRequestLogs", {
    acl: "private",
});

const hostedZone = new aws.route53.Zone("boriswebsite-hotedzone", {
    name: website
});

const eastRegion = new aws.Provider("east", {
    region: "us-east-1"
});

const certificate = new aws.acm.Certificate("cert", {
    domainName: website,
    subjectAlternativeNames: [`*.${website}`],
    validationMethod: "DNS",
    tags: {
        Name: "piers.dev"
    }
}, { provider: eastRegion });

const certValidationRecord = new aws.route53.Record("certValidationRecord", {
    name: certificate.domainValidationOptions[0].resourceRecordName,
    zoneId: hostedZone.zoneId,
    type: certificate.domainValidationOptions[0].resourceRecordType,
    records: [certificate.domainValidationOptions[0].resourceRecordValue],
    ttl: 60
}, { parent: hostedZone });

const certValidation = new aws.acm.CertificateValidation("certValidation", {
    certificateArn: certificate.arn,
    validationRecordFqdns: [certValidationRecord.fqdn]
}, { provider: eastRegion });

const cacheTimeout = 30;

const cdn = new aws.cloudfront.Distribution("cdn", {
    enabled: true,
    // Alternate aliases the CloudFront distribution can be reached at, in addition to https://xxxx.cloudfront.net.
    // Required if you want to access the distribution via config.targetDomain as well.
    aliases: [website],

    // We only specify one origin for this distribution, the S3 content bucket.
    origins: [
        {
            originId: borisBucket.arn,
            domainName: borisBucket.websiteEndpoint,
            customOriginConfig: {
                // Amazon S3 doesn't support HTTPS connections when using an S3 bucket configured as a website endpoint.
                // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-web-values-specify.html#DownloadDistValuesOriginProtocolPolicy
                originProtocolPolicy: "http-only",
                httpPort: 80,
                httpsPort: 443,
                originSslProtocols: ["TLSv1.2"],
            },
        },
    ],

    defaultRootObject: "index.html",

    // A CloudFront distribution can configure different cache behaviors based on the request path.
    // Here we just specify a single, default cache behavior which is just read-only requests to S3.
    defaultCacheBehavior: {
        targetOriginId: borisBucket.arn,

        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD", "OPTIONS"],
        cachedMethods: ["GET", "HEAD", "OPTIONS"],

        forwardedValues: {
            cookies: { forward: "none" },
            queryString: false,
        },

        minTtl: 0,
        defaultTtl: cacheTimeout,
        maxTtl: cacheTimeout,
    },

    // "All" is the most broad distribution, and also the most expensive.
    // "100" is the least broad, and also the least expensive.
    priceClass: "PriceClass_All",

    // You can customize error responses. When CloudFront receives an error from the origin (e.g. S3 or some other
    // web service) it can return a different error code, and return the response for a different resource.
    customErrorResponses: [
        { errorCode: 404, responseCode: 404, responsePagePath: "/404.html" },
    ],

    restrictions: {
        geoRestriction: {
            restrictionType: "none",
        },
    },

    viewerCertificate: {
        acmCertificateArn: certificate.arn,  // Per AWS, ACM certificate must be in the us-east-1 region.
        sslSupportMethod: "sni-only",
    },

    loggingConfig: {
        bucket: logsBucket.bucketDomainName,
        includeCookies: false,
        prefix: `${borisBucket}/`,
    },
});

const apexRecord = new aws.route53.Record("apexRecord", {
    zoneId: hostedZone.zoneId,
    name: website,
    type: aws.route53.RecordTypes.A,
    aliases: [{
        name: cdn.domainName,
        zoneId: cdn.hostedZoneId,
        evaluateTargetHealth: true
    }]
});

const wwwRecord = new aws.route53.Record("wwwrecord", {
    zoneId: hostedZone.zoneId,
    name: "www.hasborisjohnsonresignedyet.com",
    type: aws.route53.RecordTypes.CNAME,
    records: [redirectBucket.websiteEndpoint],
    ttl: 60
})