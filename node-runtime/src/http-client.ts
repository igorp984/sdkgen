import { AstJson } from "@sdkgen/parser";
import { randomBytes } from "crypto";
import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { hostname } from "os";
import { URL } from "url";
import { Context } from "./context";
import { decode, encode } from "./encode-decode";
import { SdkgenError, SdkgenErrorWithData } from "./error";

interface ErrClasses {
  [className: string]: { new (message: string, data: any): SdkgenErrorWithData<any> | SdkgenError };
}

export class SdkgenHttpClient {
  private baseUrl: URL;

  extra = new Map<string, unknown>();

  constructor(baseUrl: string, private astJson: AstJson, private errClasses: ErrClasses) {
    this.baseUrl = new URL(baseUrl);
  }

  async makeRequest(ctx: Context | null, functionName: string, args: unknown): Promise<any> {
    const func = this.astJson.functionTable[functionName];

    if (!func) {
      throw new Error(`Unknown function ${functionName}`);
    }

    const requestBody = JSON.stringify({
      args: encode(this.astJson.typeTable, `${functionName}.args`, func.args, args),
      deviceInfo: ctx && ctx.request ? ctx.request.deviceInfo : { id: hostname(), type: "node" },
      extra: {
        ...this.extra,
        ...(ctx && ctx.request ? ctx.request.extra : {}),
      },
      name: functionName,
      requestId: ctx && ctx.request ? ctx.request.id + randomBytes(6).toString("hex") : randomBytes(16).toString("hex"),
      version: 3,
    });

    const options = {
      hostname: this.baseUrl.hostname,
      method: "POST",
      path: this.baseUrl.pathname,
      port: this.baseUrl.port,
    };

    const encodedRet = await new Promise<any>((resolve, reject) => {
      const req = (this.baseUrl.protocol === "http:" ? httpRequest : httpsRequest)(options, res => {
        let data = "";

        res.on("data", chunk => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const response = JSON.parse(data);

            if (response.error) {
              reject(response.error);
            } else {
              resolve(response.result);
            }
          } catch (error) {
            if (`${error}`.includes("SyntaxError")) {
              console.error(data);
            }

            reject({ message: `${error}`, type: "Fatal" });
          }
        });
        res.on("error", error => {
          reject({ message: `${error}`, type: "Fatal" });
        });
        res.on("aborted", () => {
          reject({ message: "Request aborted", type: "Fatal" });
        });
      });

      req.on("error", error => {
        reject({ message: `${error}`, type: "Fatal" });
      });

      req.write(requestBody);
      req.end();
    }).catch(error => {
      const errClass = this.errClasses[error.type];

      if (errClass) {
        const errorJson = this.astJson.errors.find(err => (Array.isArray(err) ? err[0] === error.type : err === error.type));

        if (errorJson) {
          if (Array.isArray(errorJson)) {
            throw new errClass(error.message, decode(this.astJson.typeTable, `${errClass.name}.data`, errorJson[1], error.data));
          } else {
            throw new errClass(error.message, undefined);
          }
        }
      }

      throw new this.errClasses.Fatal(`${error.type}: ${error.message}`, undefined);
    });

    return decode(this.astJson.typeTable, `${functionName}.ret`, func.ret, encodedRet);
  }
}
